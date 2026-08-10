/** @jsxImportSource react */
import { FileDiff, type DiffLineAnnotation } from "@pierre/diffs/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReviewExpandedGapState } from "../../core/review/state";
import type { ReviewNoteV1 } from "../../core/review/types";
import type { HunkReviewActionV1, HunkReviewStateV1 } from "../../session/reviewProtocol";
import type { BrowserReviewApiClient } from "../lib/apiClient";
import {
  findReviewResource,
  isolatePierreHunk,
  parseCanonicalReviewFile,
  toPierreReviewFile,
  type PierreReviewFile,
} from "../lib/pierreDocument";
import type { BrowserReviewDocument, BrowserReviewFile } from "../lib/reviewTypes";
import type { HunkWebTheme } from "../lib/theme";
import { ReviewNote } from "./ReviewNote";

type FileResourceState =
  | { key: string; state: "deferred" | "loading" }
  | {
      key: string;
      state: "ready";
      content: string;
      expandedSourceTextById: Record<string, string>;
    }
  | { key: string; state: "error"; message: string };

const WINDOW_OVERSCAN_PX = 900;
const WINDOW_UNLOAD_HYSTERESIS_MS = 300;
type BrowserSourceStatus = NonNullable<HunkReviewStateV1["sourceStatusByFileKey"]>[string];

export interface ReviewStreamProps {
  api: BrowserReviewApiClient;
  document: BrowserReviewDocument;
  mutableNotes: readonly ReviewNoteV1[];
  selectedFileKey?: string;
  theme: HunkWebTheme;
  onVisibleFile: (fileKey: string) => void;
  mutationsEnabled?: boolean;
  stateRevision?: number;
  expandedGaps?: readonly ReviewExpandedGapState[];
  sourceStatusByFileKey?: HunkReviewStateV1["sourceStatusByFileKey"];
  onAction?: (action: HunkReviewActionV1, expectedRevision?: number) => Promise<boolean>;
}

/** Render every authoritative file wrapper in order while loading only nearby canonical data. */
export function ReviewStream(props: ReviewStreamProps) {
  if (props.document.files.length === 0) {
    return <div className="review-empty">No changed files are visible in this review.</div>;
  }
  const selectedIndex = props.document.files.findIndex(
    (file) => file.key === props.selectedFileKey,
  );
  return (
    <div className="review-stream" data-review-stream data-file-count={props.document.files.length}>
      {props.document.files.map((file, index) => (
        <ReviewFile
          key={`${props.document.generation}\0${file.canonicalResourceId}\0${file.key}`}
          {...props}
          file={file}
          initiallyNear={index < 4 || (selectedIndex >= 0 && Math.abs(index - selectedIndex) <= 3)}
        />
      ))}
    </div>
  );
}

function ReviewFile({
  api,
  document,
  file,
  mutableNotes,
  selectedFileKey,
  theme,
  onVisibleFile,
  initiallyNear,
  mutationsEnabled = false,
  stateRevision = 0,
  expandedGaps = [],
  sourceStatusByFileKey = {},
  onAction,
}: ReviewStreamProps & { file: BrowserReviewFile; initiallyNear: boolean }) {
  const selected = selectedFileKey === file.key;
  const resourceKey = `${document.generation}\0${file.canonicalResourceId}`;
  const windowable = !file.flags.binary && !file.flags.tooLarge;
  const [nearViewport, setNearViewport] = useState(initiallyNear || selected);
  const [estimatedBodyHeight, setEstimatedBodyHeight] = useState(() =>
    estimateFileBodyHeight(file),
  );
  const [resource, setResource] = useState<FileResourceState>({
    key: resourceKey,
    state: initiallyNear || selected ? "loading" : "deferred",
  });
  const sectionRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const unloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notes = [...file.notes, ...mutableNotes.filter((note) => note.fileKey === file.key)];
  const fileExpandedGaps = useMemo(
    () => expandedGaps.filter((gap) => gap.fileKey === file.key && gap.expanded),
    [expandedGaps, file.key],
  );
  const sourceStatus = sourceStatusByFileKey?.[file.key];
  const shouldLoad = nearViewport || selected;
  const mounted = !windowable || shouldLoad;
  const activeResource =
    resource.key === resourceKey
      ? resource
      : ({ key: resourceKey, state: shouldLoad ? "loading" : "deferred" } as const);
  const noteActions = (note: ReviewNoteV1) => ({
    mutationsEnabled,
    ...(onAction && note.origin === "user"
      ? {
          onUpdate: (body: string, markup: string, editStartRevision: number) =>
            onAction(
              { type: "notes/update-user", noteId: note.id, body, markup },
              editStartRevision,
            ),
          editStartRevision: stateRevision,
        }
      : {}),
    ...(onAction && (note.origin === "user" || note.origin === "live-agent")
      ? {
          onRemove: () =>
            onAction({
              type: note.origin === "user" ? "notes/remove-user" : "notes/remove-live",
              noteId: note.id,
            }),
        }
      : {}),
  });
  const pierre = useMemo<PierreReviewFile | undefined>(() => {
    if (!mounted || activeResource.state !== "ready") return undefined;
    return toPierreReviewFile(
      document,
      file,
      activeResource.content,
      mutableNotes,
      activeResource.expandedSourceTextById,
    );
  }, [activeResource, document, file, mounted, mutableNotes]);

  useEffect(() => {
    if (!windowable) return;
    if (!shouldLoad) {
      setResource({ key: resourceKey, state: "deferred" });
      api.releaseResource(document.generation, file.canonicalResourceId);
      for (const sourceId of Object.values(file.sourceResourceIds)) {
        if (sourceId) api.releaseResource(document.generation, sourceId);
      }
      return;
    }
    const descriptor = findReviewResource(document, file, file.canonicalResourceId);
    if (!descriptor) {
      setResource({
        key: resourceKey,
        state: "error",
        message: "Canonical resource descriptor is missing.",
      });
      return;
    }
    const controller = new AbortController();
    let active = true;
    setResource((current) =>
      current.key === resourceKey && current.state === "ready"
        ? current
        : { key: resourceKey, state: "loading" },
    );
    void api.resource(document.generation, descriptor, controller.signal).then(
      async (content) => {
        try {
          const canonical = parseCanonicalReviewFile(document, file, content);
          const sourceIds = [
            ...new Set([
              ...canonical.expandedContext.map((entry) => entry.sourceResourceId),
              ...(sourceStatus?.kind === "loaded"
                ? fileExpandedGaps.flatMap((entry) => {
                    const id = file.sourceResourceIds[entry.side];
                    return id ? [id] : [];
                  })
                : []),
            ]),
          ];
          const expandedSourceTextById = Object.fromEntries(
            await Promise.all(
              sourceIds.map(async (id) => {
                const source = findReviewResource(document, file, id);
                if (!source) throw new Error(`Expanded source resource ${id} is missing.`);
                return [
                  id,
                  await api.resource(document.generation, source, controller.signal),
                ] as const;
              }),
            ),
          );
          if (active) {
            setResource({ key: resourceKey, state: "ready", content, expandedSourceTextById });
          }
        } catch (error) {
          if (isAbortError(error) || !active) return;
          setResource({
            key: resourceKey,
            state: "error",
            message: error instanceof Error ? error.message : "Canonical resource is invalid.",
          });
        }
      },
      (error) => {
        if (isAbortError(error) || !active) return;
        setResource({
          key: resourceKey,
          state: "error",
          message:
            error instanceof Error ? error.message : "Canonical resource could not be loaded.",
        });
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    api,
    document.generation,
    file.canonicalResourceId,
    file.key,
    fileExpandedGaps,
    resourceKey,
    shouldLoad,
    sourceStatus?.kind,
    windowable,
  ]);

  useEffect(() => {
    const element = sectionRef.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const nearObserver = new IntersectionObserver(
      (entries) => {
        const near = entries.some((entry) => entry.isIntersecting);
        if (near) {
          if (unloadTimer.current) clearTimeout(unloadTimer.current);
          unloadTimer.current = undefined;
          setNearViewport(true);
          return;
        }
        if (selected || unloadTimer.current) return;
        unloadTimer.current = setTimeout(() => {
          const height = bodyRef.current?.getBoundingClientRect().height;
          if (height && height > 0) setEstimatedBodyHeight(height);
          setNearViewport(false);
          unloadTimer.current = undefined;
        }, WINDOW_UNLOAD_HYSTERESIS_MS);
      },
      { rootMargin: `${WINDOW_OVERSCAN_PX}px 0px`, threshold: 0 },
    );
    const visibleObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onVisibleFile(file.key);
      },
      // Whole-file sections can be many viewports tall, so any visible intersection must qualify.
      { rootMargin: "0px", threshold: 0 },
    );
    nearObserver.observe(element);
    visibleObserver.observe(element);
    return () => {
      nearObserver.disconnect();
      visibleObserver.disconnect();
      if (unloadTimer.current) clearTimeout(unloadTimer.current);
      unloadTimer.current = undefined;
    };
  }, [file.key, onVisibleFile, selected]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!mounted || !body || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const height = body.getBoundingClientRect().height;
      if (height > 0) setEstimatedBodyHeight(height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [activeResource.state, mounted]);

  return (
    <section
      ref={sectionRef}
      className={`review-file${selected ? " review-file--selected" : ""}`}
      data-file-key={file.key}
      data-file-path={file.path}
      data-resource-key={`${document.generation}:${file.canonicalResourceId}`}
      data-resource-state={mounted ? activeResource.state : "deferred"}
      data-window-state={windowable ? (mounted ? "mounted" : "spacer") : "static"}
      id={fileAnchorId(file.key)}
      tabIndex={-1}
    >
      <header className="review-file__header">
        <div className="review-file__identity">
          <h2>{file.path}</h2>
          {file.previousPath && file.previousPath !== file.path ? (
            <span className="review-file__rename">from {file.previousPath}</span>
          ) : null}
          {file.agentSummary ? (
            <span className="review-file__rename">{file.agentSummary}</span>
          ) : null}
        </div>
        <div className="review-file__badges">
          <FileStateBadges file={file} />
          {file.sourceResourceIds.new || file.sourceResourceIds.old
            ? file.hunks.map((hunk, hunkIndex) =>
                (hunk.newRange?.[0] ?? hunk.oldRange?.[0] ?? 1) > 1 ? (
                  <button
                    key={hunk.index}
                    type="button"
                    disabled={!mutationsEnabled}
                    title={`Expand or collapse source before hunk ${hunkIndex + 1}`}
                    onClick={() =>
                      void onAction?.({
                        type: "expansion/toggle",
                        fileKey: file.key,
                        gapId: `before:${hunkIndex}`,
                      })
                    }
                  >
                    Context {hunkIndex + 1}
                  </button>
                ) : null,
              )
            : null}
          {file.hasTrailingContext ? (
            <button
              type="button"
              disabled={!mutationsEnabled}
              title="Expand or collapse source after the final hunk"
              onClick={() =>
                void onAction?.({
                  type: "expansion/toggle",
                  fileKey: file.key,
                  gapId: `trailing:${Math.max(0, file.hunks.length - 1)}`,
                })
              }
            >
              Trailing context
            </button>
          ) : null}
          <span className="stat stat--add">+{file.additions}</span>
          <span className="stat stat--delete">−{file.deletions}</span>
          {file.statsTruncated ? <span>stats truncated</span> : null}
          {notes.length ? (
            <span>
              {notes.length} note{notes.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
      </header>
      {!mounted ? (
        <div
          className="review-file__spacer"
          data-estimated-height={Math.round(estimatedBodyHeight)}
          style={{ height: `${estimatedBodyHeight}px` }}
        >
          <span>Diff outside render window.</span>
        </div>
      ) : (
        <div ref={bodyRef} className="review-file__body">
          {file.flags.binary ? (
            <FilePlaceholder
              title="Binary file"
              body="Binary content is not rendered in browser review."
              notes={notes}
            />
          ) : file.flags.tooLarge ? (
            <FilePlaceholder
              title="File too large"
              body="The canonical review skipped this file's textual diff."
              notes={notes}
            />
          ) : activeResource.state === "deferred" ? (
            <div className="review-file__state" role="status">
              Diff loads when it nears the viewport.
            </div>
          ) : activeResource.state === "loading" ? (
            <div className="review-file__state" role="status">
              Loading canonical review resource…
            </div>
          ) : activeResource.state === "error" ? (
            <FilePlaceholder
              title="Resource error"
              body={activeResource.message}
              notes={notes}
              error
            />
          ) : !pierre ? null : pierre.fileDiff.hunks.length === 0 ? (
            <FilePlaceholder
              title={
                file.changeKind === "rename-pure"
                  ? "Renamed without content changes"
                  : "No textual changes"
              }
              body={
                file.changeKind === "rename-pure"
                  ? `${file.previousPath ?? file.path} → ${file.path}`
                  : "The reviewed projection contains no renderable hunks."
              }
              notes={pierre.fileNotes}
            />
          ) : (
            <>
              {pierre.movedLines || pierre.expandedContext.length > 0 ? (
                <div className="review-file__canonical-meta">
                  {pierre.movedLines ? "Moved-line metadata" : ""}
                  {pierre.movedLines && pierre.expandedContext.length ? " · " : ""}
                  {pierre.expandedContext.length
                    ? `${pierre.expandedContext.length} expanded context region${pierre.expandedContext.length === 1 ? "" : "s"}`
                    : ""}
                </div>
              ) : null}
              {pierre.fileDiff.hunks.map((hunk, hunkIndex) => {
                const before = pierre.expandedContext.filter(
                  (context) => context.gapId === `before:${hunkIndex}`,
                );
                const trailing = pierre.expandedContext.filter(
                  (context) => context.gapId === `trailing:${hunkIndex}`,
                );
                const dynamicBefore = fileExpandedGaps.filter(
                  (context) => context.gapId === `before:${hunkIndex}`,
                );
                const dynamicTrailing = fileExpandedGaps.filter(
                  (context) => context.gapId === `trailing:${hunkIndex}`,
                );
                const manifestHunk = file.hunks[hunkIndex];
                const annotations = pierre.annotations.filter((annotation) => {
                  const range =
                    annotation.side === "additions"
                      ? manifestHunk?.newRange
                      : manifestHunk?.oldRange;
                  return Boolean(
                    range && annotation.lineNumber >= range[0] && annotation.lineNumber <= range[1],
                  );
                });
                return (
                  <div key={hunkIndex} data-review-hunk={hunkIndex}>
                    {before.map((context) => (
                      <ExpandedContextBlock
                        key={`${context.gapId}:${context.side}`}
                        context={context}
                        source={pierre.expandedSourceTextById[context.sourceResourceId]}
                      />
                    ))}
                    {dynamicBefore.map((context) => (
                      <AuthoritativeGapBlock
                        key={`${context.gapId}:${context.side}`}
                        context={context}
                        sourceStatus={sourceStatus}
                        source={
                          pierre.expandedSourceTextById[file.sourceResourceIds[context.side] ?? ""]
                        }
                      />
                    ))}
                    <FileDiff<ReviewNoteV1>
                      disableWorkerPool
                      fileDiff={isolatePierreHunk(pierre.fileDiff, hunkIndex)}
                      lineAnnotations={annotations}
                      options={{
                        theme: theme.diffs,
                        themeType: theme.type,
                        diffStyle: "unified",
                        diffIndicators: "bars",
                        disableFileHeader: true,
                        overflow: "scroll",
                        hunkSeparators: "line-info-basic",
                        lineDiffType: "word-alt",
                        unsafeCSS: DIFF_UNSAFE_CSS,
                        lineHoverHighlight: "both",
                        onLineClick: ({ lineNumber, annotationSide }) => {
                          void onAction?.({
                            type: "selection/set-line",
                            fileKey: file.key,
                            hunkIndex,
                            side: annotationSide === "additions" ? "new" : "old",
                            line: lineNumber,
                            reveal: true,
                          });
                        },
                      }}
                      renderAnnotation={(annotation: DiffLineAnnotation<ReviewNoteV1>) => (
                        <ReviewNote
                          note={annotation.metadata}
                          {...noteActions(annotation.metadata)}
                        />
                      )}
                    />
                    {trailing.map((context) => (
                      <ExpandedContextBlock
                        key={`${context.gapId}:${context.side}`}
                        context={context}
                        source={pierre.expandedSourceTextById[context.sourceResourceId]}
                      />
                    ))}
                    {dynamicTrailing.map((context) => (
                      <AuthoritativeGapBlock
                        key={`${context.gapId}:${context.side}`}
                        context={context}
                        sourceStatus={sourceStatus}
                        source={
                          pierre.expandedSourceTextById[file.sourceResourceIds[context.side] ?? ""]
                        }
                      />
                    ))}
                  </div>
                );
              })}
              {pierre.fileNotes.map((note) => (
                <ReviewNote key={note.id} note={note} {...noteActions(note)} />
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** Keep non-materialized expansion feedback at the semantic gap without hiding the base diff. */
function AuthoritativeGapBlock({
  context,
  sourceStatus,
  source,
}: {
  context: ReviewExpandedGapState;
  sourceStatus?: BrowserSourceStatus;
  source?: string;
}) {
  if (sourceStatus?.kind === "loaded" && source !== undefined) {
    return <ExpandedContextBlock context={context} source={source} />;
  }
  if (sourceStatus?.kind === "error") {
    return (
      <div
        className="review-file__state review-file__state--error"
        data-gap-id={context.gapId}
        role="alert"
      >
        Expanded source could not be loaded.
      </div>
    );
  }
  return (
    <div className="review-file__state" data-gap-id={context.gapId} role="status">
      Loading expanded source…
    </div>
  );
}

/** Render one materialized source range with singular/plural line grammar. */
function ExpandedContextBlock({
  context,
  source,
}: {
  context: PierreReviewFile["expandedContext"][number] | ReviewExpandedGapState;
  source?: string;
}) {
  const range = context.side === "new" ? context.newRange : context.oldRange;
  const lines =
    source
      ?.split("\n")
      .slice(Math.max(0, range[0] - 1), range[1])
      .join("\n") ?? "";
  const lineLabel = range[0] === range[1] ? `line ${range[0]}` : `lines ${range[0]}–${range[1]}`;
  return (
    <div className="review-file__expanded" data-gap-id={context.gapId}>
      <span>
        Expanded {context.side} {lineLabel}
      </span>
      <pre>{lines}</pre>
    </div>
  );
}

function FileStateBadges({ file }: { file: BrowserReviewFile }) {
  const states = [
    file.flags.untracked ? "untracked" : "",
    file.changeKind === "new" ? "added" : "",
    file.changeKind === "deleted" ? "deleted" : "",
    file.changeKind.startsWith("rename") ? "renamed" : "",
    file.flags.partial ? "partial" : "",
    file.flags.binary ? "binary" : "",
    file.flags.tooLarge ? "large" : "",
  ].filter(Boolean);
  return states.map((state) => <span key={state}>{state}</span>);
}

function FilePlaceholder({
  title,
  body,
  notes,
  error = false,
}: {
  title: string;
  body: string;
  notes: readonly ReviewNoteV1[];
  error?: boolean;
}) {
  return (
    <div className={`review-file__placeholder${error ? " review-file__state--error" : ""}`}>
      <strong>{title}</strong>
      <p>{body}</p>
      {notes.map((note) => (
        <ReviewNote key={note.id} note={note} />
      ))}
    </div>
  );
}

/** Return the stable DOM target shared by tree selection and snapshot reveal. */
export function fileAnchorId(fileKey: string) {
  return `review-file-${fileKey.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** Estimate stable off-window geometry until ResizeObserver records the rendered body. */
function estimateFileBodyHeight(file: BrowserReviewFile) {
  return Math.max(96, Math.min(1_200, 72 + file.hunkCount * 140));
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

const DIFF_UNSAFE_CSS = `
  [data-diffs] { --diffs-font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre { border-radius: 0; }
`;

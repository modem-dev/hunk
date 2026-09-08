import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DiffFile } from "../../core/changeset/model";
import type { ExtensionFileViewCodeDocument } from "../../extension-api/types";
import type { AppTheme } from "../themes";
import {
  documentHighlightCacheKey,
  loadDocumentHighlight,
  type DocumentHighlightInput,
  type DocumentHighlightResult,
} from "../diff/documentHighlightService";
import { FILE_VIEW_MAX_CODE_DOCUMENTS } from "./layout";
import type { PlannedFileViewRow } from "./renderPlan";
import type { ResolvedFileViewLayout } from "./useFileViews";

const FILE_VIEW_HIGHLIGHT_MAX_RETRIES = 1;
const FILE_VIEW_HIGHLIGHT_RETRY_DELAY_MS = 25;
const EMPTY_FILE_VIEW_HIGHLIGHTS: ReadonlyMap<string, DocumentHighlightResult> = new Map();

interface FileViewHighlightRequest {
  cacheKey: string;
  document: ExtensionFileViewCodeDocument;
  language: string;
}

interface FileViewSyntaxHighlightState {
  contextIdentity: string;
  results: ReadonlyMap<string, DocumentHighlightResult>;
}

interface ActiveFileViewHighlightRequest {
  cacheKey: string;
  controller: AbortController;
}

interface FileViewSyntaxHighlightDependencies {
  load?: (input: DocumentHighlightInput) => Promise<DocumentHighlightResult>;
  maxRetries?: number;
  retryDelayMs?: number;
}

/** Wait between bounded retries while allowing demand removal to cancel the timer. */
function waitForRetry(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(finish, delayMs);
    function finish() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Collect syntax documents referenced by mounted extension rows, excluding inserted note rows. */
export function demandedFileViewSyntaxDocumentIds(
  mountedRows: readonly PlannedFileViewRow[],
): ReadonlySet<string> {
  const demanded = new Set<string>();
  for (const plannedRow of mountedRows) {
    if (plannedRow.kind !== "file-view-row") continue;
    for (const span of plannedRow.row.spans) {
      if (span.syntax) demanded.add(span.syntax.documentId);
    }
  }
  return demanded;
}

/** Build a delimiter-safe identity for one ordered set of demanded document requests. */
function requestSetIdentity(requests: ReadonlyMap<string, FileViewHighlightRequest>) {
  let identity = "";
  for (const [documentId, request] of requests) {
    identity += `${documentId.length}:${documentId}${request.cacheKey.length}:${request.cacheKey}`;
  }
  return identity;
}

/** Resolve complete-document syntax results only for code referenced by the mounted row halo. */
export function useFileViewSyntaxHighlight(
  {
    file,
    fileView,
    mountedRows,
    offloadLargeDiff,
    shouldLoadHighlight,
    theme,
  }: {
    file: DiffFile;
    fileView: ResolvedFileViewLayout;
    mountedRows: readonly PlannedFileViewRow[];
    offloadLargeDiff: boolean;
    shouldLoadHighlight: boolean;
    theme: AppTheme;
  },
  dependencies: FileViewSyntaxHighlightDependencies = {},
): ReadonlyMap<string, DocumentHighlightResult> {
  const demandedIds = useMemo(() => demandedFileViewSyntaxDocumentIds(mountedRows), [mountedRows]);
  const requests = useMemo(() => {
    const next = new Map<string, FileViewHighlightRequest>();
    for (const document of fileView.layout.codeDocuments ?? []) {
      if (!demandedIds.has(document.id)) continue;
      const language = document.language ?? file.language ?? "text";
      next.set(document.id, {
        cacheKey: documentHighlightCacheKey({
          language,
          path: file.path,
          text: document.text,
          theme,
        }),
        document,
        language,
      });
    }
    return next;
  }, [demandedIds, file.language, file.path, fileView.layout.codeDocuments, theme]);
  const requestIdentity = requestSetIdentity(requests);
  const contextIdentity = `${file.id.length}:${file.id}${fileView.extensionId.length}:${fileView.extensionId}${fileView.viewId.length}:${fileView.viewId}:${fileView.registrationIdentity}`;
  const [state, setState] = useState<FileViewSyntaxHighlightState | null>(null);
  const activeRef = useRef(new Map<string, ActiveFileViewHighlightRequest>());
  const retainedRef = useRef(new Map<string, DocumentHighlightResult>());
  const contextRef = useRef(contextIdentity);
  const requestRef = useRef({ offloadLargeDiff, requests, theme });
  requestRef.current = { offloadLargeDiff, requests, theme };
  const loadRef = useRef(dependencies.load ?? loadDocumentHighlight);
  loadRef.current = dependencies.load ?? loadDocumentHighlight;
  const maxRetries = Math.max(
    0,
    Math.floor(dependencies.maxRetries ?? FILE_VIEW_HIGHLIGHT_MAX_RETRIES),
  );
  const retryDelayMs = Math.max(
    0,
    Math.floor(dependencies.retryDelayMs ?? FILE_VIEW_HIGHLIGHT_RETRY_DELAY_MS),
  );

  useLayoutEffect(() => {
    const active = activeRef.current;
    if (contextRef.current !== contextIdentity) {
      for (const request of active.values()) request.controller.abort();
      active.clear();
      retainedRef.current.clear();
      contextRef.current = contextIdentity;
      setState(null);
    }

    const currentRequests = requestRef.current.requests;
    for (const [documentId, running] of active) {
      const current = currentRequests.get(documentId);
      if (!shouldLoadHighlight || !current || current.cacheKey !== running.cacheKey) {
        running.controller.abort();
        active.delete(documentId);
      }
    }

    if (!shouldLoadHighlight || currentRequests.size === 0) {
      return;
    }

    for (const [documentId, request] of currentRequests) {
      if (retainedRef.current.has(request.cacheKey) || active.has(documentId)) continue;
      const controller = new AbortController();
      const running = { cacheKey: request.cacheKey, controller };
      active.set(documentId, running);

      void (async () => {
        let result: DocumentHighlightResult | undefined;
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
          try {
            result = await loadRef.current({
              language: request.language,
              offloadLargeDiff: requestRef.current.offloadLargeDiff,
              path: file.path,
              signal: controller.signal,
              text: request.document.text,
              theme: requestRef.current.theme,
            });
          } catch {
            if (controller.signal.aborted) return;
            result = Object.freeze({
              status: "fallback",
              reason: "highlight-failed",
              retryable: true,
            });
          }
          if (controller.signal.aborted) return;
          if (!result.retryable || attempt === maxRetries) break;
          try {
            await waitForRetry(retryDelayMs, controller.signal);
          } catch {
            return;
          }
        }

        if (!result || controller.signal.aborted || active.get(documentId) !== running) return;
        active.delete(documentId);
        retainedRef.current.delete(request.cacheKey);
        retainedRef.current.set(request.cacheKey, result);
        while (retainedRef.current.size > FILE_VIEW_MAX_CODE_DOCUMENTS) {
          const oldest = retainedRef.current.keys().next().value;
          if (oldest === undefined) break;
          retainedRef.current.delete(oldest);
        }
        setState({
          contextIdentity,
          results: new Map(retainedRef.current),
        });
      })();
    }
  }, [contextIdentity, maxRetries, requestIdentity, retryDelayMs, shouldLoadHighlight]);

  useLayoutEffect(
    () => () => {
      for (const request of activeRef.current.values()) request.controller.abort();
      activeRef.current.clear();
    },
    [],
  );

  if (!shouldLoadHighlight || state?.contextIdentity !== contextIdentity) {
    return EMPTY_FILE_VIEW_HIGHLIGHTS;
  }
  const highlighted = new Map<string, DocumentHighlightResult>();
  for (const [documentId, request] of requests) {
    const result = state.results.get(request.cacheKey);
    if (result) highlighted.set(documentId, result);
  }
  return highlighted.size > 0 ? highlighted : EMPTY_FILE_VIEW_HIGHLIGHTS;
}

import { useLayoutEffect, useMemo, useState } from "react";
import type { DiffFile } from "../../core/changeset/model";
import type { AppTheme } from "../themes";
import {
  loadHighlightedSourceLines,
  sourceHasIncompatibleLoneCarriageReturn,
  type HighlightedSourceCode,
} from "./diffRows";
import { documentHighlightCacheKey } from "./documentHighlightService";

const SOURCE_HIGHLIGHT_MAX_RETRIES = 1;
const SOURCE_HIGHLIGHT_RETRY_DELAY_MS = 25;

interface HighlightedSourceState {
  cacheKey: string;
  highlighted: HighlightedSourceCode;
}

interface HighlightedSourceDependencies {
  load?: typeof loadHighlightedSourceLines;
  maxRetries?: number;
  retryDelayMs?: number;
}

/** Build the same strong identity as the shared service plus source-geometry newline policy. */
function buildSourceCacheKey(theme: AppTheme, file: DiffFile, text: string) {
  const serviceKey = documentHighlightCacheKey({
    language: file.language ?? "text",
    path: file.path,
    text,
    theme,
  });
  return `${serviceKey}:source-newlines:${sourceHasIncompatibleLoneCarriageReturn(text) ? "incompatible" : "compatible"}`;
}

/** Wait between bounded retries while allowing effect cleanup to cancel the timer. */
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

/** Resolve shared full-source highlighting while preserving plain rows throughout async work. */
export function useHighlightedSource(
  {
    file,
    offloadLargeDiff = false,
    text,
    theme,
    shouldLoadHighlight,
  }: {
    file: DiffFile | undefined;
    offloadLargeDiff?: boolean;
    text: string | undefined;
    theme: AppTheme;
    shouldLoadHighlight?: boolean;
  },
  dependencies: HighlightedSourceDependencies = {},
) {
  const [state, setState] = useState<HighlightedSourceState | null>(null);
  const cacheKey = useMemo(
    () => (file && text !== undefined ? buildSourceCacheKey(theme, file, text) : null),
    [file, text, theme],
  );
  const load = dependencies.load ?? loadHighlightedSourceLines;
  const maxRetries = Math.max(
    0,
    Math.floor(dependencies.maxRetries ?? SOURCE_HIGHLIGHT_MAX_RETRIES),
  );
  const retryDelayMs = Math.max(
    0,
    Math.floor(dependencies.retryDelayMs ?? SOURCE_HIGHLIGHT_RETRY_DELAY_MS),
  );

  useLayoutEffect(() => {
    if (!file || text === undefined || !cacheKey || !shouldLoadHighlight) {
      setState(null);
      return;
    }

    const controller = new AbortController();
    let active = true;
    setState((current) => (current?.cacheKey === cacheKey ? current : null));

    void (async () => {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        let highlighted: HighlightedSourceCode;
        try {
          highlighted = await load({
            file,
            offloadLargeDiff,
            signal: controller.signal,
            text,
            theme,
          });
        } catch {
          if (!active || controller.signal.aborted) return;
          highlighted = {
            result: Object.freeze({
              status: "fallback",
              reason: "highlight-failed",
              retryable: true,
            }),
          };
        }

        if (!active || controller.signal.aborted) return;
        setState({ cacheKey, highlighted });
        if (!highlighted.result.retryable || attempt === maxRetries) return;

        try {
          await waitForRetry(retryDelayMs, controller.signal);
        } catch {
          return;
        }
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [
    cacheKey,
    file,
    load,
    maxRetries,
    offloadLargeDiff,
    retryDelayMs,
    shouldLoadHighlight,
    text,
    theme,
  ]);

  return state?.cacheKey === cacheKey ? state.highlighted : null;
}

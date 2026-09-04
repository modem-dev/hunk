/// <reference lib="webworker" />
/**
 * Highlights diff metadata away from the terminal event loop.
 *
 * The main thread sends bounded data-only custom grammars before matching highlight jobs. Grammar
 * changes dispose the worker-local shared highlighter and cache before any new result is produced.
 */
import {
  RegisteredCustomLanguages,
  disposeHighlighter,
  getHighlighterOptions,
  getSharedHighlighter,
  registerCustomLanguage,
  renderDiffWithHighlighter,
  type FileDiffMetadata,
} from "@pierre/diffs";
import type { ExtensionSyntaxGrammar } from "../../../extension-api/types";
import { aliasContextHighlightLines } from "./highlightContext";
import {
  cloneCompactHighlightedDiff,
  compactHighlightTransferList,
  encodeCompactHighlightedDiff,
  type CompactHighlightedDiff,
  type HighlightedHastLines,
} from "./highlightCompact";
import { HighlightWorkerCache } from "./highlightWorkerCache";
import { highlightWorkerCacheKey } from "./highlightWorkerIdentity";

type HighlightWorkerRequest =
  | {
      version: 4;
      type: "configure";
      generation: number;
      digest: string;
      grammars: readonly ExtensionSyntaxGrammar[];
    }
  | {
      version: 4;
      type: "highlight";
      id: number;
      grammarGeneration: number;
      aliasContext: boolean;
      metadata: FileDiffMetadata;
      appearance: "dark" | "light";
      language: string;
      theme: string;
    };

type HighlightWorkerResponse =
  | { version: 4; type: "configured"; generation: number; ok: true }
  | { version: 4; type: "configured"; generation: number; ok: false; message: string }
  | { version: 4; type: "highlight"; id: number; ok: true; code: CompactHighlightedDiff }
  | { version: 4; type: "highlight"; id: number; ok: false; message: string };

const highlightedDiffCache = new HighlightWorkerCache();
let grammarGeneration = -1;
let grammarDigest = "";
let customGrammarIds: readonly string[] = [];

/** Build the fixed Pierre render options shared with the terminal highlighter. */
function workerRenderOptions(theme: string) {
  return {
    theme: theme as "pierre-dark",
    useTokenTransformer: false,
    tokenizeMaxLineLength: 1_000,
    lineDiffType: "word-alt" as const,
    maxLineDiffLength: 10_000,
  };
}

/** Convert an unknown thrown value into a reply that survives structured clone. */
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Reject malformed internal configuration instead of corrupting the worker registry. */
function assertGrammarConfiguration(
  grammars: unknown,
): asserts grammars is ExtensionSyntaxGrammar[] {
  if (!Array.isArray(grammars) || grammars.length > 64) {
    throw new Error("Invalid syntax grammar configuration.");
  }
  const ids = new Set<string>();
  for (const grammar of grammars) {
    if (
      typeof grammar !== "object" ||
      grammar === null ||
      typeof grammar.id !== "string" ||
      typeof grammar.scopeName !== "string" ||
      !Array.isArray(grammar.patterns) ||
      ids.has(grammar.id)
    ) {
      throw new Error("Invalid syntax grammar configuration.");
    }
    ids.add(grammar.id);
  }
}

/** Apply one complete grammar generation to this worker. */
async function configureGrammars(request: Extract<HighlightWorkerRequest, { type: "configure" }>) {
  if (request.generation === grammarGeneration && request.digest === grammarDigest) return;
  assertGrammarConfiguration(request.grammars);
  await disposeHighlighter();
  for (const id of customGrammarIds) RegisteredCustomLanguages.delete(id);
  for (const grammar of request.grammars) {
    const registration = {
      name: grammar.id,
      scopeName: grammar.scopeName,
      patterns: grammar.patterns,
      repository: grammar.repository ?? {},
    };
    registerCustomLanguage(grammar.id, async () => ({ default: [registration] as never[] }));
  }
  customGrammarIds = request.grammars.map(({ id }) => id);
  grammarGeneration = request.generation;
  grammarDigest = request.digest;
  highlightedDiffCache.clear();
}

declare const self: Worker;

self.onmessage = async (event: MessageEvent<HighlightWorkerRequest>) => {
  const request = event.data;
  if (request.version !== 4) return;

  if (request.type === "configure") {
    try {
      await configureGrammars(request);
      const response: HighlightWorkerResponse = {
        version: 4,
        type: "configured",
        generation: request.generation,
        ok: true,
      };
      self.postMessage(response);
    } catch (error) {
      const response: HighlightWorkerResponse = {
        version: 4,
        type: "configured",
        generation: request.generation,
        ok: false,
        message: errorMessage(error),
      };
      self.postMessage(response);
    }
    return;
  }

  const { aliasContext, appearance, id, language, metadata, theme } = request;
  if (request.grammarGeneration !== grammarGeneration) {
    const response: HighlightWorkerResponse = {
      version: 4,
      type: "highlight",
      id,
      ok: false,
      message: "Syntax grammar configuration changed before highlighting.",
    };
    self.postMessage(response);
    return;
  }

  try {
    const cacheKey = highlightWorkerCacheKey({
      aliasContext,
      appearance,
      language,
      metadata,
      theme,
    });
    let code = highlightedDiffCache.get(cacheKey);
    if (!code) {
      const highlighter = await getSharedHighlighter({
        ...getHighlighterOptions(language, { theme: theme as never }),
        preferredHighlighter: "shiki-wasm",
      });
      const result = renderDiffWithHighlighter(metadata, highlighter, workerRenderOptions(theme));
      const highlighted = result.code as {
        deletionLines: HighlightedHastLines;
        additionLines: HighlightedHastLines;
      };
      const cachedCode = encodeCompactHighlightedDiff(
        aliasContext ? aliasContextHighlightLines(metadata, highlighted) : highlighted,
        appearance,
      );
      code = highlightedDiffCache.set(cacheKey, cachedCode)
        ? cloneCompactHighlightedDiff(cachedCode)
        : cachedCode;
    }
    const response: HighlightWorkerResponse = { version: 4, type: "highlight", id, ok: true, code };
    self.postMessage(response, compactHighlightTransferList(code));
  } catch (error) {
    const response: HighlightWorkerResponse = {
      version: 4,
      type: "highlight",
      id,
      ok: false,
      message: errorMessage(error),
    };
    self.postMessage(response);
  }
};

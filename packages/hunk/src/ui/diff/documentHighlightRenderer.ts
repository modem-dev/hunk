import {
  getHighlighterOptions,
  getSharedHighlighter,
  renderFileWithHighlighter,
  type FileContents,
} from "@pierre/diffs";
import type { AppTheme } from "../themes";
import { pierreHighlightRenderOptions } from "./highlightRenderOptions";
import {
  ensureSyntaxHighlightThemeRegistered,
  syntaxHighlightThemeName,
} from "./syntaxHighlightTheme";
import type { HastNode } from "./worker";

export type HighlightThemeInput = AppTheme | AppTheme["appearance"];
type HighlightOptions = ReturnType<typeof getHighlighterOptions>;

const highlighterOptionsByKey = new Map<string, HighlightOptions>();
let queuedHighlightWork = Promise.resolve();

/** Marks a language or theme that Pierre cannot resolve from registered syntax resources. */
export class DocumentHighlighterConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentHighlighterConfigurationError";
  }
}

/** Convert only Pierre's stable missing-resource failures into permanent configuration errors. */
function classifyHighlighterPreparationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /resolveLanguage: .* not found in bundled or custom languages/u.test(message) ||
    /No valid theme loader registered/u.test(message)
    ? new DocumentHighlighterConfigurationError(message)
    : error;
}

/** Return the light/dark mode for a theme object or legacy appearance argument. */
export function highlightThemeAppearance(theme: HighlightThemeInput) {
  return typeof theme === "string" ? theme : theme.appearance;
}

/** Prepare one language/theme pair through Pierre's shared Shiki highlighter. */
export async function prepareDocumentHighlighter(
  language: string | undefined,
  theme: HighlightThemeInput,
) {
  const resolvedLanguage = language ?? "text";
  const syntaxTheme = ensureSyntaxHighlightThemeRegistered(theme);
  const cacheKey = `${syntaxTheme}:${resolvedLanguage}`;
  const options =
    highlighterOptionsByKey.get(cacheKey) ??
    getHighlighterOptions(resolvedLanguage, {
      theme: syntaxTheme,
    });

  if (!highlighterOptionsByKey.has(cacheKey)) {
    highlighterOptionsByKey.set(cacheKey, options);
  }

  try {
    return await getSharedHighlighter({
      ...options,
      preferredHighlighter: "shiki-wasm",
    });
  } catch (error) {
    throw classifyHighlighterPreparationError(error);
  }
}

/** Serialize main-thread Shiki rendering while yielding to terminal input between jobs. */
export function queueDocumentHighlightWork<T>(run: () => T | PromiseLike<T>, signal?: AbortSignal) {
  const queued = queuedHighlightWork.then(
    () =>
      new Promise<T>((resolve, reject) => {
        setTimeout(() => {
          if (signal?.aborted) {
            reject(signal.reason ?? new Error("Document highlight work was aborted."));
            return;
          }
          try {
            resolve(run());
          } catch (error) {
            reject(error);
          }
        }, 0);
      }),
  );

  queuedHighlightWork = queued.then(
    () => undefined,
    () => undefined,
  );

  return queued;
}

/** Render one complete document in one Shiki call so lexical state crosses line boundaries. */
export async function renderHighlightedDocumentLines({
  cacheKey,
  language,
  path,
  signal,
  text,
  theme,
}: {
  cacheKey: string;
  language: string;
  path: string;
  signal?: AbortSignal;
  text: string;
  theme: HighlightThemeInput;
}): Promise<Array<HastNode | undefined>> {
  return queueDocumentHighlightWork(async () => {
    if (signal?.aborted) throw signal.reason ?? new Error("Document highlight work was aborted.");
    const highlighter = await prepareDocumentHighlighter(language, theme);
    if (signal?.aborted) throw signal.reason ?? new Error("Document highlight work was aborted.");
    const contents: FileContents = {
      name: path,
      contents: text,
      cacheKey,
      lang: language as FileContents["lang"],
    };
    const highlighted = renderFileWithHighlighter(
      contents,
      highlighter,
      pierreHighlightRenderOptions(syntaxHighlightThemeName(theme)),
    );
    const lines = highlighted.code as Array<HastNode | undefined>;
    if (text.length === 0) return [];
    return text.endsWith("\n") ? lines.slice(0, -1) : lines;
  }, signal);
}

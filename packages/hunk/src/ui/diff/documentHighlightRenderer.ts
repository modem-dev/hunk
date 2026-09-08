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

  return getSharedHighlighter({
    ...options,
    preferredHighlighter: "shiki-wasm",
  });
}

/** Serialize main-thread Shiki rendering while yielding to terminal input between jobs. */
export function queueDocumentHighlightWork<T>(run: () => T) {
  const queued = queuedHighlightWork.then(
    () =>
      new Promise<T>((resolve, reject) => {
        setTimeout(() => {
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
  text,
  theme,
}: {
  cacheKey: string;
  language: string;
  path: string;
  text: string;
  theme: HighlightThemeInput;
}): Promise<Array<HastNode | undefined>> {
  const highlighter = await prepareDocumentHighlighter(language, theme);
  return queueDocumentHighlightWork(() => {
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
  });
}

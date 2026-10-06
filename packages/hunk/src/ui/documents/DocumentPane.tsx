import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { MutableRefObject } from "react";
import type { DocumentReadResult } from "../../core/documents/source";
import { fileLanguageForPath } from "../../core/documents/fileLanguageLookup";
import {
  documentHighlightRunsForLine,
  loadDocumentHighlight,
  type DocumentHighlightResult,
} from "../syntax/documentHighlightService";
import type { AppTheme } from "../themes";
import { useRowViewport } from "./useRowViewport";
import {
  completeDocumentLines,
  completeDocumentGeometry,
  completeDocumentWindow,
  completeDocumentLineAt,
} from "./geometry";

/** Paint complete documents with the host syntax service; syntax arrival never changes row geometry. */
export function DocumentPane({
  document,
  documentKey,
  pathHint,
  height,
  width,
  wrap,
  tabWidth,
  theme,
  lineNumbers,
  focused,
  scrollRef,
  visibleLineRef,
}: {
  document: DocumentReadResult | null;
  documentKey: string | null;
  pathHint: string;
  height: number;
  width: number;
  wrap: boolean;
  tabWidth: number;
  theme: AppTheme;
  lineNumbers: boolean;
  focused: boolean;
  scrollRef: MutableRefObject<ScrollBoxRenderable | null>;
  visibleLineRef: MutableRefObject<() => number>;
}) {
  const viewport = useRowViewport(height, width);
  const text = document?.kind === "text" ? document.text : "";
  const lines = useMemo(() => completeDocumentLines(text, tabWidth), [text, tabWidth]);
  const safeText = useMemo(() => lines.join("\n"), [lines]);
  const [paint, setPaint] = useState<{
    text: string;
    theme: AppTheme;
    key: string | null;
    result: DocumentHighlightResult;
  } | null>(null);
  const layout = useMemo(() => {
    try {
      return { geometry: completeDocumentGeometry(lines, viewport.width, lineNumbers, wrap), wrap };
    } catch {
      return {
        geometry: completeDocumentGeometry(lines, viewport.width, lineNumbers, false),
        wrap: false,
      };
    }
  }, [lines, viewport.width, lineNumbers, wrap]);
  const { geometry } = layout;
  visibleLineRef.current = () =>
    Math.max(
      1,
      Math.min(
        lines.length,
        completeDocumentLineAt(geometry, viewport.ref.current?.scrollTop ?? 0) + 1,
      ),
    );
  const gutter = geometry.gutter;
  const window = completeDocumentWindow(geometry, viewport.top, viewport.height);
  const previousGeometry = useRef({ documentKey, geometry });
  useLayoutEffect(() => {
    const previous = previousGeometry.current;
    const scroll = viewport.ref.current;
    if (scroll && previous.documentKey === documentKey && previous.geometry !== geometry) {
      const top = Math.floor(scroll.scrollTop);
      const line = completeDocumentLineAt(previous.geometry, top);
      scroll.scrollTo({
        x: layout.wrap ? 0 : scroll.scrollLeft,
        y: geometry.rows[Math.max(0, line)]?.start ?? 0,
      });
    }
    previousGeometry.current = { documentKey, geometry };
  }, [documentKey, geometry, layout.wrap, viewport.ref]);
  const result =
    paint?.text === safeText && paint.theme === theme && paint.key === documentKey
      ? paint.result
      : null;
  useEffect(() => {
    scrollRef.current = viewport.ref.current;
    return () => {
      scrollRef.current = null;
    };
  }, [scrollRef, viewport.ref]);
  useEffect(() => {
    viewport.ref.current?.scrollTo(0);
  }, [documentKey, viewport.ref]);
  useEffect(() => {
    if (!documentKey || document?.kind !== "text") return;
    const controller = new AbortController();
    void loadDocumentHighlight({
      text: safeText,
      path: pathHint,
      language:
        document.language ??
        fileLanguageForPath(
          process.platform === "win32" ? pathHint.replaceAll("\\", "/") : pathHint,
        ) ??
        "text",
      theme,
      offloadLargeDiff: false,
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted)
          setPaint({ text: safeText, key: documentKey, theme, result });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [document, documentKey, pathHint, safeText, theme]);

  /** Project syntax runs and fill token gaps with ordinary foreground paint. */
  const paintLine = (line: string, index: number) => {
    let offset = 0;
    const spans: { text: string; fg?: string }[] = [];
    for (const run of documentHighlightRunsForLine(result, index)) {
      if (run.start > offset) spans.push({ text: line.slice(offset, run.start) });
      spans.push({ text: line.slice(run.start, run.end), fg: run.fg });
      offset = run.end;
    }
    if (offset < line.length) spans.push({ text: line.slice(offset) });
    return spans.map((span, index) => (
      <span key={index} fg={span.fg ?? theme.text}>
        {span.text}
      </span>
    ));
  };
  const placeholder =
    document?.kind === "unavailable"
      ? document.detail
      : !documentKey
        ? "Select a file to view its complete document."
        : !document
          ? "Loading…"
          : !lines.length
            ? "Empty file."
            : null;
  return (
    <scrollbox
      ref={viewport.ref}
      width="100%"
      height="100%"
      scrollY={true}
      scrollX={!layout.wrap}
      focused={focused}
      // Semantic commands own keyboard navigation, including explicit unbindings.
      onKeyDown={(key) => key.preventDefault()}
    >
      {placeholder ? (
        <text fg={theme.muted}>{` ${placeholder}`}</text>
      ) : (
        <box width={geometry.width} flexDirection="column">
          {window.start > 0 ? (
            <box height={geometry.rows[window.start]?.start ?? geometry.totalHeight} />
          ) : null}
          {lines.slice(window.start, window.end).map((line, offset) => {
            const index = window.start + offset;
            return (
              <text
                key={index}
                width={geometry.width}
                height={geometry.rows[index]!.height}
                wrapMode={layout.wrap ? "word" : "none"}
                fg={theme.text}
              >
                {lineNumbers ? (
                  <span fg={theme.muted}>{`${String(index + 1).padStart(gutter - 2)}  `}</span>
                ) : null}
                {paintLine(line, index)}
              </text>
            );
          })}
          {window.end < lines.length ? (
            <box height={geometry.totalHeight - geometry.rows[window.end]!.start} />
          ) : null}
        </box>
      )}
    </scrollbox>
  );
}

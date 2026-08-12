/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewNoteV1 } from "../../core/review/types";
import { ReviewNote } from "./ReviewNote";

const note: ReviewNoteV1 = {
  id: "note:complete",
  source: "agent",
  origin: "live-agent",
  originalSource: "mcp",
  fileKey: "file:1",
  anchor: { intersectingHunkIndices: [], ownerHunkIndex: 0 },
  title: "Complete note",
  author: "Pi",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  summary: "Visible summary",
  rationale: "Visible rationale",
  markup: "<strong>Rich body</strong><script><img src=x onerror=alert(1)></script>",
  editable: false,
  tags: ["safety"],
  confidence: "high",
};

describe("browser review note", () => {
  test("renders complete projected content through sanitized STML nodes, never raw HTML", () => {
    const html = renderToStaticMarkup(<ReviewNote note={note} />);
    expect(html).toContain("Complete note");
    expect(html).not.toContain("Visible summary");
    expect(html).not.toContain("Visible rationale");
    expect(html).toContain("Rich body");
    expect(html).toContain("source: mcp");
    expect(html).toContain("#safety");
    expect(html).not.toContain("onerror=");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  test("keeps an empty visual STML box as valid replacement content", () => {
    const html = renderToStaticMarkup(<ReviewNote note={{ ...note, markup: "<box></box>" }} />);
    expect(html).toContain("stml-box");
    expect(html).not.toContain("Visible summary");
  });

  test("falls back to summary and rationale when markup degrades to no content", () => {
    const html = renderToStaticMarkup(
      <ReviewNote note={{ ...note, markup: "<unknown></unknown>" }} />,
    );
    expect(html).toContain("Visible summary");
    expect(html).toContain("Visible rationale");
  });
});

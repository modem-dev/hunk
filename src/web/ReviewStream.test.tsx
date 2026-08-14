/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatReviewAddress } from "../core/review/address";
import { projectReviewDocument } from "../core/review/document";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import { buildReviewFileRenderModel } from "./pierreDocument";
import { ReviewStream } from "./ReviewStream";
import { DEFAULT_BROWSER_VIEW_OPTIONS } from "./viewOptions";

const BASE = `${Array.from({ length: 24 }, (_unused, index) => `line ${index + 1}`).join("\n")}\n`;
const CHANGED = BASE.replace("line 4", "line 4 changed");

/** The document a review of these two files publishes, in this order. */
function documentFor() {
  return projectReviewDocument(
    [
      createTestDiffFile({
        id: "alpha",
        path: "src/alpha.ts",
        before: BASE,
        after: CHANGED,
        context: 3,
      }),
      createTestDiffFile({ id: "beta", path: "src/beta.ts", before: BASE, after: BASE }),
    ],
    { sourceLabel: "/repo" },
  );
}

/** Render the stream to markup, which is as far as a static render can take it. */
function render(width = 1_400) {
  const document = documentFor();
  return {
    document,
    markup: renderToStaticMarkup(
      <ReviewStream
        document={document}
        view={DEFAULT_BROWSER_VIEW_OPTIONS}
        viewportWidth={width}
      />,
    ),
  };
}

describe("ReviewStream", () => {
  test("renders every file, in the document's order", () => {
    const { markup } = render();

    expect(markup.indexOf("src/alpha.ts")).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf("src/beta.ts")).toBeGreaterThan(markup.indexOf("src/alpha.ts"));
  });

  test("addresses each file and hunk through the shared address grammar", () => {
    const { document, markup } = render();
    const file = document.files[0]!;

    expect(markup).toContain(formatReviewAddress({ kind: "file", fileKey: file.key }));
    expect(markup).toContain(
      formatReviewAddress({ kind: "hunk", fileKey: file.key, hunkIndex: 0 }),
    );
  });

  test("shows the churn badges the shared formatter produced", () => {
    const { document, markup } = render();
    const file = document.files[0]!;

    expect(markup).toContain(`+${file.stats.additions}`);
    expect(markup).toContain(`-${file.stats.deletions}`);
  });

  test("explains a file with nothing to render instead of drawing an empty diff", () => {
    const { markup } = render();

    expect(markup).toContain("No changes to show.");
  });

  test("offers each collapsed region by the line count core addressed it with", () => {
    const { document, markup } = render();
    const gaps = buildReviewFileRenderModel(document.files[0]!).gaps;

    expect(gaps).not.toHaveLength(0);
    for (const gap of gaps) {
      expect(markup).toContain(`${gap.lineCount} unchanged`);
      // The label is the gap's own addresses, not a count this component computed.
      expect(markup).toContain(`-${gap.oldRange[0]},${gap.lineCount}`);
    }
    // Closed until a reader opens it: nothing is fetched for a region nobody looked at.
    expect(markup).toContain('aria-expanded="false"');
  });
});

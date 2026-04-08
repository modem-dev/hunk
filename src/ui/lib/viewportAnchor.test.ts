import { describe, expect, test } from "bun:test";
import { resolveTheme } from "../themes";
import { buildInStreamFileHeaderHeights } from "./fileSectionLayout";
import { measureDiffSectionGeometry } from "./diffSectionGeometry";
import { findViewportRowAnchor, resolveViewportRowAnchorTop } from "./viewportAnchor";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";

describe("viewport row anchors", () => {
  const theme = resolveTheme("midnight", null);

  function createChangedFile() {
    return createTestDiffFile({
      after: lines("const alpha = 2;"),
      before: lines("const alpha = 1;"),
      id: "viewport-anchor",
      path: "viewport-anchor.ts",
    });
  }

  test("honors a preferred stable key when a split change row can map to multiple stacked rows", () => {
    const file = createChangedFile();
    const headerHeights = buildInStreamFileHeaderHeights([file]);
    const splitGeometry = measureDiffSectionGeometry(
      file,
      "split",
      false,
      theme,
      [],
      120,
      true,
      false,
    );
    const stackGeometry = measureDiffSectionGeometry(
      file,
      "stack",
      false,
      theme,
      [],
      120,
      true,
      false,
    );
    const splitChangeTop = splitGeometry.rowBounds.find((row) => row.key.includes(":change:"))?.top;
    const stackDeletionTop = stackGeometry.rowBounds.find((row) =>
      row.key.includes(":deletion:"),
    )?.top;
    const stackAdditionTop = stackGeometry.rowBounds.find((row) =>
      row.key.includes(":addition:"),
    )?.top;

    expect(splitChangeTop).toBeDefined();
    expect(stackDeletionTop).toBeDefined();
    expect(stackAdditionTop).toBeDefined();

    const deletionAnchor = findViewportRowAnchor(
      [file],
      [stackGeometry],
      stackDeletionTop!,
      headerHeights,
    );
    const additionAnchor = findViewportRowAnchor(
      [file],
      [stackGeometry],
      stackAdditionTop!,
      headerHeights,
    );

    const splitAsDeletion = findViewportRowAnchor(
      [file],
      [splitGeometry],
      splitChangeTop!,
      headerHeights,
      deletionAnchor?.stableKey,
    );
    const splitAsAddition = findViewportRowAnchor(
      [file],
      [splitGeometry],
      splitChangeTop!,
      headerHeights,
      additionAnchor?.stableKey,
    );

    expect(splitAsDeletion?.stableKey).toBe(deletionAnchor?.stableKey);
    expect(splitAsAddition?.stableKey).toBe(additionAnchor?.stableKey);
  });

  test("round-trips a stacked deletion row through split view without changing the viewport anchor", () => {
    const file = createChangedFile();
    const headerHeights = buildInStreamFileHeaderHeights([file]);
    const splitGeometry = measureDiffSectionGeometry(
      file,
      "split",
      false,
      theme,
      [],
      120,
      true,
      false,
    );
    const stackGeometry = measureDiffSectionGeometry(
      file,
      "stack",
      false,
      theme,
      [],
      120,
      true,
      false,
    );
    const stackDeletionTop = stackGeometry.rowBounds.find((row) =>
      row.key.includes(":deletion:"),
    )?.top;

    expect(stackDeletionTop).toBeDefined();

    const stackDeletionAnchor = findViewportRowAnchor(
      [file],
      [stackGeometry],
      stackDeletionTop!,
      headerHeights,
    );

    expect(stackDeletionAnchor).not.toBeNull();

    const splitTop = resolveViewportRowAnchorTop(
      [file],
      [splitGeometry],
      stackDeletionAnchor!,
      headerHeights,
    );
    const splitAnchor = findViewportRowAnchor(
      [file],
      [splitGeometry],
      splitTop,
      headerHeights,
      stackDeletionAnchor?.stableKey,
    );
    const roundTripTop = resolveViewportRowAnchorTop(
      [file],
      [stackGeometry],
      splitAnchor!,
      headerHeights,
    );

    expect(roundTripTop).toBe(stackDeletionTop!);
  });
});

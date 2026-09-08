import { describe, expect, test } from "bun:test";
import { agentNoteBoxLayout, agentNoteMarkupWidth } from "./agentNoteGeometry";

describe("agentNoteBoxLayout", () => {
  test("unified layout gives the note nearly the full pane", () => {
    const { boxWidth, contentWidth } = agentNoteBoxLayout({
      anchorSide: "new",
      layout: "unified",
      width: 120,
    });
    expect(boxWidth).toBe(116);
    expect(contentWidth).toBe(112);
  });

  test("split layout docks new-side notes to roughly half the pane", () => {
    const { boxWidth, boxLeft } = agentNoteBoxLayout({
      anchorSide: "new",
      layout: "split",
      width: 120,
    });
    expect(boxWidth).toBeLessThan(70);
    expect(boxLeft).toBe(120 - boxWidth);
  });

  test("split layout docks old-side notes on the left", () => {
    const { boxLeft } = agentNoteBoxLayout({ anchorSide: "old", layout: "split", width: 120 });
    expect(boxLeft).toBe(0);
  });

  test("narrow split panes fall back to full-width placement", () => {
    const wide = agentNoteBoxLayout({ anchorSide: "new", layout: "split", width: 83 });
    expect(wide.boxWidth).toBe(79);
  });

  test("never collapses below the minimum card width", () => {
    const { boxWidth, contentWidth } = agentNoteBoxLayout({
      anchorSide: "new",
      layout: "unified",
      width: 20,
    });
    expect(boxWidth).toBeGreaterThanOrEqual(16);
    expect(contentWidth).toBeGreaterThanOrEqual(1);
  });

  test("huge terminals grow the markup width with the pane", () => {
    expect(agentNoteMarkupWidth({ anchorSide: "new", layout: "unified", width: 220 })).toBe(212);
    expect(
      agentNoteMarkupWidth({ anchorSide: "new", layout: "split", width: 220 }),
    ).toBeGreaterThan(100);
  });
});

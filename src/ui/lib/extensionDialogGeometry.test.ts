import { describe, expect, test } from "bun:test";
import type { ExtensionInfoDialogRequest } from "./extensionDialogs";
import {
  planExtensionInfoDialog,
  windowDialogLiteralText,
  windowDialogText,
} from "./extensionDialogGeometry";

const infoRequest = {
  id: 1,
  kind: "info",
  extensionId: "example",
  showAttribution: true,
  title: "Agent setup",
  bodyLines: ["Teach your agent how to review this Hunk session."],
  copy: {
    label: "Prompt",
    text: "Load the Hunk skill and use it for this review. Run hunk skill path.",
    displayLines: ["Load the Hunk skill and use it for this review. Run hunk skill path."],
  },
} satisfies ExtensionInfoDialogRequest;

describe("windowDialogText", () => {
  test("wraps prose within the available terminal-cell rows", () => {
    expect(windowDialogText(["one two three"], 7, 3)).toEqual({
      lines: ["one two", "three"],
      truncated: false,
    });
  });

  test("pins an overflow marker to the final allocated row", () => {
    expect(windowDialogText(["one two three four"], 7, 2)).toEqual({
      lines: ["one two", "…"],
      truncated: true,
    });
    expect(windowDialogText(["overflow"], 3, 0)).toEqual({ lines: [], truncated: true });
  });
});

describe("windowDialogLiteralText", () => {
  test("wraps copyable text without collapsing whitespace", () => {
    expect(windowDialogLiteralText(["  one  two", "    three"], 7, 4)).toEqual({
      lines: ["  one  ", "two", "    thr", "ee"],
      truncated: false,
    });
  });

  test("keeps meaningful literal text in a one-row window", () => {
    expect(windowDialogLiteralText(["one  two"], 5, 1)).toEqual({
      lines: ["one …"],
      truncated: true,
    });
  });

  test("marks a substituted cluster as incomplete disclosure", () => {
    expect(windowDialogLiteralText(["界"], 1, 1)).toEqual({
      lines: ["…"],
      truncated: true,
    });
  });

  test("marks invisible clusters as incomplete disclosure", () => {
    expect(windowDialogLiteralText(["\u200b"], 4, 1)).toEqual({
      lines: ["\u200b"],
      truncated: true,
    });
  });

  test("marks invisible scalars inside a visible grapheme as incomplete disclosure", () => {
    const taggedFlag = "\u{1F3F4}\u{E0061}\u{E0062}\u{E007F}";
    expect(windowDialogLiteralText([taggedFlag], 4, 1)).toEqual({
      lines: [taggedFlag],
      truncated: true,
    });
  });
});

describe("planExtensionInfoDialog", () => {
  test("exposes copy only when its complete payload and attribution fit", () => {
    const complete = planExtensionInfoDialog(infoRequest, 50, 20);
    const constrained = planExtensionInfoDialog(infoRequest, 50, 12);

    expect(complete.visibleCopy.truncated).toBe(false);
    expect(complete.copyActionExposed).toBe(true);
    expect(constrained.visibleCopy.truncated).toBe(true);
    expect(constrained.copyActionExposed).toBe(false);
  });

  test("prioritizes required attribution over info actions", () => {
    const layout = planExtensionInfoDialog(infoRequest, 50, 7);

    expect(layout.attributionRows).toBe(1);
    expect(layout.attributionText).toBe("ext example");
    expect(layout.actionRows).toBe(0);
    expect(layout.copyActionExposed).toBe(false);
  });

  test("withholds copy when required attribution is truncated", () => {
    const layout = planExtensionInfoDialog({ ...infoRequest, extensionId: "x".repeat(80) }, 50, 30);

    expect(layout.attributionText).not.toBe(`ext ${"x".repeat(80)}`);
    expect(layout.visibleCopy.truncated).toBe(false);
    expect(layout.copyActionExposed).toBe(false);
  });

  test("withholds copy when frame chrome leaves no real card width", () => {
    const layout = planExtensionInfoDialog(
      {
        ...infoRequest,
        showAttribution: false,
        bodyLines: [],
        copy: { label: "Content", text: "x", displayLines: ["x"] },
      },
      6,
      30,
    );

    expect(layout.visibleCopy.truncated).toBe(false);
    expect(layout.copyActionExposed).toBe(false);
  });
});

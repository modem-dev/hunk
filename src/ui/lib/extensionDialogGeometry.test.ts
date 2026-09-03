import { describe, expect, test } from "bun:test";
import type { ExtensionOpenDialogRequest } from "./extensionDialogs";
import { planExtensionOpenDialog, windowDialogText } from "./extensionDialogGeometry";

const TestDialog = () => null;
const openRequest = {
  id: 1,
  kind: "open",
  extensionId: "example",
  showAttribution: true,
  title: "Custom surface",
  width: 64,
  height: 12,
  component: TestDialog,
  actionLease: { active: true },
} satisfies ExtensionOpenDialogRequest;

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

describe("planExtensionOpenDialog", () => {
  test("gives the component its preferred rectangle after host attribution", () => {
    const layout = planExtensionOpenDialog(openRequest, 120, 40);

    expect(layout.frame).toMatchObject({ width: 68, height: 19 });
    expect(layout.bodyWidth).toBe(64);
    expect(layout.componentHeight).toBe(12);
    expect(layout.attributionRows).toBe(1);
    expect(layout.attributionGapRows).toBe(1);
    expect(layout.attributionText).toBe("ext example");
  });

  test("clamps the component rectangle while preserving attribution first", () => {
    const layout = planExtensionOpenDialog(openRequest, 50, 12);

    expect(layout.frame).toMatchObject({ width: 48, height: 10 });
    expect(layout.bodyWidth).toBe(44);
    expect(layout.attributionRows).toBe(1);
    expect(layout.attributionGapRows).toBe(1);
    expect(layout.componentHeight).toBe(3);
  });

  test("gives bundled components the attribution rows they do not need", () => {
    const layout = planExtensionOpenDialog({ ...openRequest, showAttribution: false }, 120, 40);

    expect(layout.frame.height).toBe(17);
    expect(layout.attributionRows).toBe(0);
    expect(layout.attributionGapRows).toBe(0);
    expect(layout.componentHeight).toBe(12);
  });
});

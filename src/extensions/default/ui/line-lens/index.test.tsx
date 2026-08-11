import { describe, expect, test } from "bun:test";
import { BuiltInLineLens } from ".";
import type { ExtensionPaneProps } from "../../../types";

/** Build the public props needed to inspect the bundled fixed-pane composition. */
function paneProps(render: (side: "old" | "new", width: number) => unknown): ExtensionPaneProps {
  return {
    files: [],
    selectedFileId: null,
    selectedHunkIndex: null,
    placement: "bottom",
    width: 48,
    height: 3,
    theme: {
      appearance: "dark",
      background: "#000000",
      panel: "#111111",
      panelAlt: "#222222",
      border: "#333333",
      accent: "#444444",
      accentMuted: "#555555",
      text: "#ffffff",
      muted: "#999999",
      selectedHunk: "#666666",
      badgeAdded: "#00ff00",
      badgeRemoved: "#ff0000",
      badgeNeutral: "#777777",
      fileNew: "#00ff00",
      fileDeleted: "#ff0000",
      fileRenamed: "#ffff00",
      fileModified: "#00ffff",
      fileUntracked: "#ff00ff",
      noteBorder: "#888888",
    },
    keybindings: { matches: () => false, getKeys: () => [] },
    actions: { selectFile() {}, selectHunk() {}, notify() {} },
    currentLine: { render },
  };
}

describe("bundled current-line lens pane", () => {
  test("paints old above new at the exact host width", () => {
    const calls: Array<["old" | "new", number]> = [];
    const rendered = BuiltInLineLens(
      paneProps((side, width) => {
        calls.push([side, width]);
        return side;
      }),
    ) as { props: { children: unknown[]; style: { height: number; width: number } } };

    expect(calls).toEqual([
      ["old", 48],
      ["new", 48],
    ]);
    expect(rendered.props.style).toMatchObject({ width: 48, height: 3 });
    expect(rendered.props.children.slice(1)).toEqual(["old", "new"]);
  });

  test("renders nothing without an accepted current-line painter", () => {
    expect(BuiltInLineLens({ ...paneProps(() => null), currentLine: null })).toBeNull();
  });
});

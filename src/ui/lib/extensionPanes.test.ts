import { describe, expect, test } from "bun:test";
import type { RegisteredPane } from "../../extensions/types";
import { createEmptyExtensionLoadResult } from "../../extensions/types";
import { HUNK_FILES_PANE_KEY, HUNK_LINE_LENS_PANE_KEY } from "../../extensions/extensionIds";
import {
  buildSessionPanes,
  initialPaneOpenState,
  planExtensionPanes,
  reconcilePaneOpenState,
  resolvePaneKey,
  type SessionPane,
} from "./extensionPanes";

function registeredPane(
  extensionId: string,
  id: string,
  pane: Partial<RegisteredPane["pane"]> = {},
): RegisteredPane {
  return { extensionId, pane: { id, component: () => null, ...pane } };
}
function loadResultWith(panes: RegisteredPane[]) {
  const result = createEmptyExtensionLoadResult();
  result.registry.panes.push(...panes);
  return result;
}

describe("extension panes", () => {
  test("offers bundled files and line lens before user panes", () => {
    const panes = buildSessionPanes(undefined);
    expect(panes.map((pane) => pane.key)).toEqual([HUNK_FILES_PANE_KEY, HUNK_LINE_LENS_PANE_KEY]);
    expect(panes.map((pane) => pane.defaultOpen)).toEqual([true, false]);
  });

  test("a replacement changes only the initial bundled files default", () => {
    const panes = buildSessionPanes(
      loadResultWith([registeredPane("meta", "files", { replaces: HUNK_FILES_PANE_KEY })]),
    );
    expect(panes.map((pane) => [pane.key, pane.defaultOpen])).toEqual([
      [HUNK_FILES_PANE_KEY, false],
      [HUNK_LINE_LENS_PANE_KEY, false],
      ["meta:files", true],
    ]);
  });

  test("replacement defaults apply to any registered pane key", () => {
    const panes = buildSessionPanes(
      loadResultWith([
        registeredPane("meta", "base", { defaultOpen: true }),
        registeredPane("other", "replacement", { replaces: "meta:base" }),
      ]),
    );

    expect(panes.find((pane) => pane.key === "meta:base")?.defaultOpen).toBe(false);
    expect(panes.find((pane) => pane.key === "other:replacement")?.defaultOpen).toBe(true);
  });

  test("preserves open choices across reloads and applies new defaults", () => {
    const before = buildSessionPanes(
      loadResultWith([registeredPane("meta", "extra", { defaultOpen: true })]),
    );
    const state = initialPaneOpenState(before);
    const closed = { known: state.known, open: [HUNK_FILES_PANE_KEY] };
    const after = buildSessionPanes(
      loadResultWith([
        registeredPane("meta", "extra", { defaultOpen: true }),
        registeredPane("meta", "fresh", { defaultOpen: true }),
      ]),
    );
    expect(reconcilePaneOpenState(after, closed).open).toEqual([HUNK_FILES_PANE_KEY, "meta:fresh"]);
  });

  test("resolves local, files, and qualified ids", () => {
    const panes = buildSessionPanes(loadResultWith([registeredPane("meta", "extra")]));
    expect(resolvePaneKey(panes, "meta", "extra")).toBe("meta:extra");
    expect(resolvePaneKey(panes, "meta", "files")).toBe(HUNK_FILES_PANE_KEY);
    expect(resolvePaneKey(panes, "other", "meta:extra")).toBe("meta:extra");
  });

  test("plans all four edges around one review rectangle", () => {
    const session = (
      key: string,
      placement: SessionPane["placement"],
      size: number,
    ): SessionPane => ({
      key,
      placement,
      title: key,
      defaultOpen: true,
      registered: registeredPane(key.split(":")[0]!, key.split(":")[1]!, {
        placement,
        thickness: { preferred: size, min: size, max: size },
      }),
    });
    const panes = [
      session("a:left", "left", 20),
      session("b:right", "right", 15),
      session("c:top", "top", 4),
      session("d:bottom", "bottom", 3),
    ];
    const plan = planExtensionPanes({
      panes,
      openKeys: panes.map((pane) => pane.key),
      sizes: {},
      bodyWidth: 100,
      bodyHeight: 30,
      minReviewWidth: 40,
      minReviewHeight: 5,
      currentLine: null,
      availabilityContext: { files: [], selectedFileId: null, selectedHunkIndex: null },
    });
    expect(plan.reviewBounds).toEqual({ x: 20, y: 4, width: 65, height: 23 });
    expect(plan.panes.map((entry) => entry.pane.placement)).toEqual([
      "left",
      "right",
      "top",
      "bottom",
    ]);
  });

  test("keeps logical open preferences while synchronous availability omits a pane", () => {
    let available = false;
    const registered = registeredPane("a", "detail", {
      placement: "bottom",
      thickness: { preferred: 3, min: 3, max: 3 },
      currentLine: true,
      available: ({ currentLine }) => available && currentLine !== null,
    });
    const panes = buildSessionPanes(loadResultWith([registered]));
    const state = { known: panes.map((pane) => pane.key), open: ["a:detail"] };
    const options = {
      panes,
      openKeys: state.open,
      sizes: {},
      bodyWidth: 100,
      bodyHeight: 20,
      minReviewWidth: 40,
      minReviewHeight: 5,
      availabilityContext: { files: [], selectedFileId: null, selectedHunkIndex: null },
    } as const;

    const unavailable = planExtensionPanes({ ...options, currentLine: null });
    expect(unavailable.panes.some((entry) => entry.pane.key === "a:detail")).toBe(false);
    expect(unavailable.omittedKeys).toContain("a:detail");
    expect(state.open).toEqual(["a:detail"]);

    available = true;
    const paint = { render: () => null };
    const restored = planExtensionPanes({ ...options, currentLine: paint });
    expect(restored.panes.some((entry) => entry.pane.key === "a:detail")).toBe(true);
    expect(state.open).toEqual(["a:detail"]);
  });

  test("quarantines an availability callback that throws or returns asynchronously", () => {
    const throwing = registeredPane("a", "throwing", {
      available: () => {
        throw new Error("availability exploded");
      },
    });
    const asyncPane = registeredPane("a", "async", {
      available: (() => Promise.resolve(true)) as never,
    });
    const panes = buildSessionPanes(loadResultWith([throwing, asyncPane]));
    const quarantined = new WeakSet<RegisteredPane>();
    const errors: string[] = [];
    const plan = planExtensionPanes({
      panes,
      openKeys: ["a:throwing", "a:async"],
      sizes: {},
      bodyWidth: 100,
      bodyHeight: 20,
      minReviewWidth: 40,
      minReviewHeight: 5,
      currentLine: null,
      availabilityContext: { files: [], selectedFileId: null, selectedHunkIndex: null },
      quarantined,
      onAvailabilityError: (_pane, error) =>
        errors.push(error instanceof Error ? error.message : String(error)),
    });

    expect(plan.panes).toEqual([]);
    expect(plan.omittedKeys).toEqual(["a:throwing", "a:async"]);
    expect(quarantined.has(throwing)).toBe(true);
    expect(quarantined.has(asyncPane)).toBe(true);
    expect(errors).toEqual([
      "availability exploded",
      "available() must return a boolean synchronously",
    ]);
  });

  test("uses axis-neutral size overrides and reserves a divider only for resizable panes", () => {
    const registered = registeredPane("a", "top", {
      placement: "top",
      thickness: { preferred: 4, min: 2, max: 8 },
    });
    const panes = buildSessionPanes(loadResultWith([registered]));
    const plan = planExtensionPanes({
      panes,
      openKeys: ["a:top"],
      sizes: { "a:top": 7 },
      bodyWidth: 100,
      bodyHeight: 20,
      minReviewWidth: 40,
      minReviewHeight: 5,
      currentLine: null,
      availabilityContext: { files: [], selectedFileId: null, selectedHunkIndex: null },
    });

    const top = plan.panes.find((entry) => entry.pane.key === "a:top");
    expect(top?.bounds).toEqual({ x: 0, y: 0, width: 100, height: 7 });
    expect(top?.divider).toEqual({ x: 0, y: 7, width: 100, height: 1 });
    expect(plan.reviewBounds).toEqual({ x: 0, y: 8, width: 100, height: 12 });
  });

  test("omits later panes when minimum review bounds are exhausted", () => {
    const panes: SessionPane[] = ["one", "two", "three"].map((id) => ({
      key: `a:${id}`,
      placement: "left",
      title: id,
      defaultOpen: true,
      registered: registeredPane("a", id, {
        placement: "left",
        thickness: { preferred: 30, min: 20 },
      }),
    }));
    const plan = planExtensionPanes({
      panes,
      openKeys: panes.map((pane) => pane.key),
      sizes: {},
      bodyWidth: 110,
      bodyHeight: 30,
      minReviewWidth: 48,
      minReviewHeight: 5,
      currentLine: null,
      availabilityContext: { files: [], selectedFileId: null, selectedHunkIndex: null },
    });
    expect(plan.panes.map((entry) => entry.pane.key)).toEqual(["a:one", "a:two"]);
    expect(plan.omittedKeys).toContain("a:three");
  });
});

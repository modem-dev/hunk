import { describe, expect, test } from "bun:test";
import type {
  ExtensionPaneAvailabilityContext,
  ExtensionPaneComponent,
  ExtensionPanePlacement,
  ExtensionPaneSize,
} from "../../extension-api/types";
import type { RegisteredPane } from "../../extensions/types";
import { createEmptyExtensionLoadResult } from "../../extensions/types";
import { HUNK_FILES_PANE_KEY } from "../../extensions/extensionIds";
import {
  buildSessionPanes,
  initialPaneOpenState,
  planExtensionPanes,
  probeExtensionPaneAvailability,
  reconcilePaneOpenState,
  resolvePaneKey,
  resolvePaneSlotKey,
  type SessionPane,
} from "./extensionPanes";

type TestPaneOverrides = Partial<{
  title: string;
  placement: ExtensionPanePlacement;
  width: ExtensionPaneSize;
  height: ExtensionPaneSize;
  defaultOpen: boolean;
  replaces: string;
  currentLine: boolean;
  available: (context: ExtensionPaneAvailabilityContext) => boolean;
  component: ExtensionPaneComponent;
}>;

function registeredPane(
  extensionId: string,
  id: string,
  pane: TestPaneOverrides = {},
): RegisteredPane {
  return {
    extensionId,
    pane: { id, component: () => null, ...pane } as RegisteredPane["pane"],
  };
}
function loadResultWith(panes: RegisteredPane[]) {
  const result = createEmptyExtensionLoadResult();
  result.registry.panes.push(...panes);
  return result;
}

describe("extension panes", () => {
  test("offers the bundled files pane before user panes", () => {
    const panes = buildSessionPanes(undefined);
    expect(panes.map((pane) => pane.key)).toEqual([HUNK_FILES_PANE_KEY, "hunk:review-info"]);
    expect(panes.map((pane) => pane.defaultOpen)).toEqual([true, true]);
  });

  test("a replacement changes only the initial bundled files default", () => {
    const panes = buildSessionPanes(
      loadResultWith([registeredPane("meta", "files", { replaces: HUNK_FILES_PANE_KEY })]),
    );
    expect(panes.map((pane) => [pane.key, pane.defaultOpen])).toEqual([
      [HUNK_FILES_PANE_KEY, false],
      ["hunk:review-info", true],
      ["meta:files", true],
    ]);
  });

  test("replacement defaults apply to any registered pane key", () => {
    const panes = buildSessionPanes(
      loadResultWith([
        registeredPane("meta", "base", { defaultOpen: true }),
        registeredPane("other", "replacement", {
          replaces: "meta:base",
          defaultOpen: false,
        }),
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

  test("resolves a named pane slot to its open owner or fallback", () => {
    const panes = buildSessionPanes(
      loadResultWith([registeredPane("meta", "files", { replaces: HUNK_FILES_PANE_KEY })]),
    );
    const replacement = panes.find((pane) => pane.key === "meta:files")!;
    const resolve = (openKeys: readonly string[], quarantined?: WeakSet<RegisteredPane>) =>
      resolvePaneSlotKey({
        panes,
        slotKey: HUNK_FILES_PANE_KEY,
        openKeys,
        quarantined,
      });

    expect(resolve([replacement.key])).toBe(replacement.key);
    expect(resolve([HUNK_FILES_PANE_KEY])).toBe(HUNK_FILES_PANE_KEY);
    expect(resolve([])).toBe(replacement.key);

    const quarantined = new WeakSet([replacement.registered]);
    expect(resolve([replacement.key], quarantined)).toBe(HUNK_FILES_PANE_KEY);
  });

  test("follows named replacement chains to the pane filling the slot", () => {
    const panes = buildSessionPanes(
      loadResultWith([
        registeredPane("meta", "files", { replaces: HUNK_FILES_PANE_KEY }),
        registeredPane("other", "files", { replaces: "meta:files" }),
      ]),
    );
    const resolve = (openKeys: readonly string[]) =>
      resolvePaneSlotKey({ panes, slotKey: HUNK_FILES_PANE_KEY, openKeys });

    expect(resolve(["other:files"])).toBe("other:files");
    expect(resolve(["meta:files"])).toBe("meta:files");
    expect(resolve([])).toBe("other:files");
  });

  test("resolves bare ids locally and qualified ids exactly", () => {
    const panes = buildSessionPanes(
      loadResultWith([registeredPane("meta", "extra"), registeredPane("meta", "files")]),
    );
    expect(resolvePaneKey(panes, "meta", "extra")).toBe("meta:extra");
    expect(resolvePaneKey(panes, "meta", "files")).toBe("meta:files");
    expect(resolvePaneKey(panes, "meta", HUNK_FILES_PANE_KEY)).toBe(HUNK_FILES_PANE_KEY);
    expect(resolvePaneKey(panes, "other", "files")).toBeUndefined();
    expect(resolvePaneKey(panes, "other", "meta:extra")).toBe("meta:extra");
  });

  test("anchors delegated review info above the review and beside the files pane", () => {
    const panes = buildSessionPanes(undefined);
    const probe = probeExtensionPaneAvailability({
      panes,
      context: {
        review: { kind: "change-request", provider: "GitHub", title: "Title", id: "#1" },
        files: [],
        selectedFileId: null,
        selectedHunkIndex: null,
      },
      currentLine: null,
    });
    const layout = planExtensionPanes({
      panes,
      openKeys: panes
        .filter((pane) => probe.available.has(pane.registered))
        .map((pane) => pane.key),
      sizes: {},
      bodyWidth: 240,
      bodyHeight: 30,
      minReviewWidth: 40,
      minReviewHeight: 5,
    });
    const files = layout.panes.find((pane) => pane.pane.key === HUNK_FILES_PANE_KEY)!;
    const info = layout.panes.find((pane) => pane.pane.key === "hunk:review-info")!;
    expect(files.bounds).toEqual({ x: 0, y: 0, width: 38, height: 30 });
    expect(info.bounds).toEqual({ x: 39, y: 0, width: 201, height: 3 });
    expect(info.divider).toBeUndefined();
    expect(layout.reviewBounds).toEqual({ x: 39, y: 3, width: 201, height: 27 });
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
        ...(placement === "left" || placement === "right"
          ? { width: { preferred: size, min: size, max: size } }
          : { height: { preferred: size, min: size, max: size } }),
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
    });
    expect(plan.reviewBounds).toEqual({ x: 20, y: 4, width: 65, height: 23 });
    expect(plan.panes.map((entry) => entry.pane.placement)).toEqual([
      "left",
      "right",
      "top",
      "bottom",
    ]);
  });

  test("separates commit-phase availability from pure geometry planning", () => {
    let available = false;
    let availabilityCalls = 0;
    const registered = registeredPane("a", "detail", {
      placement: "bottom",
      height: { preferred: 3, min: 3, max: 3 },
      currentLine: true,
      available: ({ currentLine }) => {
        availabilityCalls += 1;
        return available && currentLine !== null;
      },
    });
    const panes = buildSessionPanes(loadResultWith([registered]));
    const context = {
      review: null,
      files: [],
      selectedFileId: null,
      selectedHunkIndex: null,
    } as const;
    const geometry = {
      panes,
      sizes: {},
      bodyWidth: 100,
      bodyHeight: 20,
      minReviewWidth: 40,
      minReviewHeight: 5,
    } as const;

    const unavailable = probeExtensionPaneAvailability({ panes, context, currentLine: null });
    expect(unavailable.available.has(registered)).toBeFalse();
    expect(planExtensionPanes({ ...geometry, openKeys: [] }).panes).toEqual([]);
    expect(availabilityCalls).toBe(1);

    available = true;
    const paint = { side: "new" as const, line: 1, render: () => null };
    const restored = probeExtensionPaneAvailability({ panes, context, currentLine: paint });
    expect(restored.available.has(registered)).toBeTrue();
    expect(planExtensionPanes({ ...geometry, openKeys: ["a:detail"] }).panes).toHaveLength(1);

    const callsBeforePending = availabilityCalls;
    const pending = probeExtensionPaneAvailability({
      panes,
      context,
      currentLine: null,
      retainCurrentLineRegistrations: new Set([registered]),
    });
    expect(pending.available.has(registered)).toBeTrue();
    expect(availabilityCalls).toBe(callsBeforePending);
  });

  test("passes delegated review metadata into pane availability", () => {
    const review = Object.freeze({
      kind: "change-request" as const,
      provider: "GitHub",
      title: "Metadata",
      id: "#1",
    });
    let received: unknown;
    const registered = registeredPane("a", "review", {
      available: (context) => {
        received = context.review;
        return context.review?.kind === "change-request";
      },
    });
    const panes = buildSessionPanes(loadResultWith([registered]));
    const probe = probeExtensionPaneAvailability({
      panes,
      context: { review, files: [], selectedFileId: null, selectedHunkIndex: null },
      currentLine: null,
    });
    expect(received).toBe(review);
    expect(probe.available.has(registered)).toBeTrue();
  });

  test("does not retain a same-key replacement by stale registration identity", () => {
    const previous = registeredPane("a", "detail", {
      currentLine: true,
      available: () => true,
    });
    let replacementCalls = 0;
    const replacement = registeredPane("a", "detail", {
      currentLine: true,
      available: () => {
        replacementCalls += 1;
        return false;
      },
    });
    const panes = buildSessionPanes(loadResultWith([replacement]));
    const probe = probeExtensionPaneAvailability({
      panes,
      context: { review: null, files: [], selectedFileId: null, selectedHunkIndex: null },
      currentLine: null,
      retainCurrentLineRegistrations: new Set([previous]),
    });

    expect(replacementCalls).toBe(1);
    expect(probe.available.has(replacement)).toBeFalse();
  });

  test("returns availability failures without quarantining or notifying", () => {
    const throwing = registeredPane("a", "throwing", {
      available: () => {
        throw new Error("availability exploded");
      },
    });
    const asyncPane = registeredPane("a", "async", {
      available: (() => Promise.resolve(true)) as never,
    });
    const panes = buildSessionPanes(loadResultWith([throwing, asyncPane]));
    const probe = probeExtensionPaneAvailability({
      panes,
      context: { review: null, files: [], selectedFileId: null, selectedHunkIndex: null },
      currentLine: null,
    });

    expect(probe.available.size).toBe(1);
    expect(probe.failures.map(({ error }) => (error as Error).message)).toEqual([
      "availability exploded",
      "available() must return a boolean synchronously",
    ]);

    let called = 0;
    throwing.pane.available = () => {
      called += 1;
      return true;
    };
    planExtensionPanes({
      panes,
      openKeys: ["a:throwing"],
      sizes: {},
      bodyWidth: 100,
      bodyHeight: 20,
      minReviewWidth: 40,
      minReviewHeight: 5,
    });
    expect(called).toBe(0);
  });

  test("resolves responsive targets from the full body axis before manual overrides", () => {
    const left: SessionPane = {
      key: "a:left",
      placement: "left",
      title: "left",
      defaultOpen: true,
      registered: registeredPane("a", "left", {
        placement: "left",
        width: { preferred: 34, min: 22, max: 56, fraction: 0.16 },
      }),
    };
    const top: SessionPane = {
      key: "a:top",
      placement: "top",
      title: "top",
      defaultOpen: true,
      registered: registeredPane("a", "top", {
        placement: "top",
        height: { preferred: 8, min: 3, max: 12, fraction: 0.25 },
      }),
    };
    const plan = (bodyWidth: number, sizes: Record<string, number> = {}) =>
      planExtensionPanes({
        panes: [left, top],
        openKeys: [left.key, top.key],
        sizes,
        bodyWidth,
        bodyHeight: 40,
        minReviewWidth: 48,
        minReviewHeight: 5,
      });

    expect(plan(100).panes.map(({ bounds }) => [bounds.width, bounds.height])).toEqual([
      [22, 40],
      [77, 10],
    ]);
    expect(plan(238).panes.map(({ bounds }) => [bounds.width, bounds.height])).toEqual([
      [38, 40],
      [199, 10],
    ]);
    expect(plan(400).panes[0]?.bounds.width).toBe(56);
    expect(plan(238, { "a:left": 47 }).panes[0]?.bounds.width).toBe(47);
  });

  test("rounds fractional cells before bounds and allocates competing panes in order", () => {
    const pane = (id: string, min: number): SessionPane => ({
      key: `a:${id}`,
      placement: "left",
      title: id,
      defaultOpen: true,
      registered: registeredPane("a", id, {
        placement: "left",
        width: { preferred: 20, min, max: 80, fraction: 0.6 },
      }),
    });
    const panes = [pane("one", 10), pane("two", 10), pane("three", 20)];
    const plan = planExtensionPanes({
      panes,
      openKeys: panes.map(({ key }) => key),
      sizes: {},
      bodyWidth: 100,
      bodyHeight: 30,
      minReviewWidth: 20,
      minReviewHeight: 5,
    });

    expect(plan.panes.map(({ pane: planned, bounds }) => [planned.key, bounds.width])).toEqual([
      ["a:one", 60],
      ["a:two", 18],
    ]);
    expect(plan.omittedKeys).toEqual(["a:three"]);

    const halfTie: SessionPane = {
      key: "a:half",
      placement: "left",
      title: "half",
      defaultOpen: true,
      registered: registeredPane("a", "half", {
        placement: "left",
        width: { preferred: 10, min: 1, max: 50, fraction: 0.1 },
      }),
    };
    expect(
      planExtensionPanes({
        panes: [halfTie],
        openKeys: [halfTie.key],
        sizes: {},
        bodyWidth: 225,
        bodyHeight: 30,
        minReviewWidth: 20,
        minReviewHeight: 5,
      }).panes[0]?.bounds.width,
    ).toBe(23);
  });

  test("sizes top and bottom fractional panes from the full body height", () => {
    const pane = (id: string, placement: "top" | "bottom"): SessionPane => ({
      key: `a:${id}`,
      placement,
      title: id,
      defaultOpen: true,
      registered: registeredPane("a", id, {
        placement,
        height: { preferred: 8, min: 3, max: 20, fraction: 0.25 },
      }),
    });
    const panes = [pane("top", "top"), pane("bottom", "bottom")];
    const heights = (bodyHeight: number) =>
      planExtensionPanes({
        panes,
        openKeys: panes.map(({ key }) => key),
        sizes: {},
        bodyWidth: 100,
        bodyHeight,
        minReviewWidth: 20,
        minReviewHeight: 5,
      }).panes.map(({ bounds }) => bounds.height);

    expect(heights(40)).toEqual([10, 10]);
    expect(heights(60)).toEqual([15, 15]);
  });

  test("uses explicit height overrides and reserves a divider only for resizable panes", () => {
    const registered = registeredPane("a", "top", {
      placement: "top",
      height: { preferred: 4, min: 2, max: 8 },
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
        width: { preferred: 30, min: 20 },
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
    });
    expect(plan.panes.map((entry) => entry.pane.key)).toEqual(["a:one", "a:two"]);
    expect(plan.omittedKeys).toContain("a:three");
  });
});

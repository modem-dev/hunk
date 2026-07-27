import { describe, expect, test } from "bun:test";
import type { RegisteredSidebarView } from "../../extensions/types";
import { createEmptyExtensionLoadResult } from "../../extensions/types";
import {
  buildSessionSidebarViews,
  bundledSidebarViewKey,
  initialSidebarOpenState,
  planSidebarLayout,
  reconcileSidebarOpenState,
  resolveSidebarViewKey,
  type SessionSidebarView,
} from "./sidebarPanes";

function registeredView(
  extensionId: string,
  id: string,
  view: Partial<RegisteredSidebarView["view"]> = {},
): RegisteredSidebarView {
  return { extensionId, view: { id, component: () => null, ...view } };
}

/** Load result whose registry carries exactly the given sidebar views. */
function loadResultWith(views: RegisteredSidebarView[]) {
  const result = createEmptyExtensionLoadResult();
  result.registry.sidebarViews.push(...views);
  return result;
}

describe("buildSessionSidebarViews", () => {
  test("offers the bundled file navigation first, open by default", () => {
    const views = buildSessionSidebarViews(undefined);

    expect(views.map((view) => view.key)).toEqual([bundledSidebarViewKey()]);
    expect(views[0]?.defaultOpen).toBe(true);
    expect(views[0]?.placement).toBe("left");
  });

  test("registered views join closed unless they ask to open", () => {
    const views = buildSessionSidebarViews(
      loadResultWith([
        registeredView("meta", "extra", { placement: "right" }),
        registeredView("meta", "eager", { defaultOpen: true }),
      ]),
    );

    expect(views.map((view) => [view.key, view.defaultOpen, view.placement])).toEqual([
      [bundledSidebarViewKey(), true, "left"],
      ["meta:extra", false, "right"],
      ["meta:eager", true, "left"],
    ]);
  });

  test("a replacesDefault view opens and closes the bundled view", () => {
    const views = buildSessionSidebarViews(
      loadResultWith([registeredView("meta", "replacement", { replacesDefault: true })]),
    );

    expect(views.map((view) => [view.key, view.defaultOpen])).toEqual([
      [bundledSidebarViewKey(), false],
      ["meta:replacement", true],
    ]);
  });
});

describe("reconcileSidebarOpenState", () => {
  test("keeps user choices for surviving views and applies defaults to new ones", () => {
    const before = buildSessionSidebarViews(
      loadResultWith([registeredView("meta", "extra", { defaultOpen: true })]),
    );
    const state = initialSidebarOpenState(before);
    // The user closed the extension view mid-session.
    const closed = { known: state.known, open: [bundledSidebarViewKey()] };

    const after = buildSessionSidebarViews(
      loadResultWith([
        registeredView("meta", "extra", { defaultOpen: true }),
        registeredView("meta", "fresh", { defaultOpen: true }),
      ]),
    );
    const next = reconcileSidebarOpenState(after, closed);

    // "extra" stays closed (the user said so); "fresh" opens per its default.
    expect(next.open).toEqual([bundledSidebarViewKey(), "meta:fresh"]);
  });

  test("returns the same state object when nothing changed", () => {
    const views = buildSessionSidebarViews(undefined);
    const state = initialSidebarOpenState(views);

    expect(reconcileSidebarOpenState(views, state)).toBe(state);
  });
});

describe("resolveSidebarViewKey", () => {
  const views = buildSessionSidebarViews(loadResultWith([registeredView("meta", "extra")]));

  test("resolves bare ids within the calling extension", () => {
    expect(resolveSidebarViewKey(views, "meta", "extra")).toBe("meta:extra");
  });

  test('resolves "files" to the bundled view and full keys to anyone', () => {
    expect(resolveSidebarViewKey(views, "meta", "files")).toBe(bundledSidebarViewKey());
    expect(resolveSidebarViewKey(views, "other", "meta:extra")).toBe("meta:extra");
  });

  test("reports unknown views as undefined", () => {
    expect(resolveSidebarViewKey(views, "meta", "missing")).toBeUndefined();
  });
});

describe("planSidebarLayout", () => {
  function sessionView(key: string, placement: "left" | "right"): SessionSidebarView {
    return {
      key,
      registered: registeredView(key.split(":")[0] ?? key, key.split(":")[1] ?? key),
      placement,
      title: key,
      defaultOpen: false,
    };
  }

  const options = {
    defaultWidth: 30,
    minWidth: 20,
    dividerWidth: 1,
    bodyWidth: 200,
    diffMinWidth: 48,
  };

  test("splits open panes by placement and totals their columns", () => {
    const plan = planSidebarLayout({
      ...options,
      views: [sessionView("a:one", "left"), sessionView("b:two", "right")],
      openKeys: ["a:one", "b:two"],
      widths: { "b:two": 40 },
    });

    expect(plan.left.map((pane) => [pane.view.key, pane.width])).toEqual([["a:one", 30]]);
    expect(plan.right.map((pane) => [pane.view.key, pane.width])).toEqual([["b:two", 40]]);
    expect(plan.leftWidth).toBe(31);
    expect(plan.totalWidth).toBe(72);
  });

  test("drops the panes that no longer fit, later views first", () => {
    const plan = planSidebarLayout({
      ...options,
      bodyWidth: 110,
      views: [
        sessionView("a:one", "left"),
        sessionView("b:two", "left"),
        sessionView("c:three", "left"),
      ],
      openKeys: ["a:one", "b:two", "c:three"],
      widths: {},
    });

    // 110 - 48 leaves 62: two 30-column panes with dividers fit, the third not.
    expect(plan.left.map((pane) => pane.view.key)).toEqual(["a:one", "b:two"]);
  });

  test("closed views consume nothing", () => {
    const plan = planSidebarLayout({
      ...options,
      views: [sessionView("a:one", "left")],
      openKeys: [],
      widths: {},
    });

    expect(plan.left).toEqual([]);
    expect(plan.totalWidth).toBe(0);
  });
});

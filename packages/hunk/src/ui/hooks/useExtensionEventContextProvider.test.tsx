import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, StrictMode, useLayoutEffect, useState } from "react";
import type {
  ExtensionDialogs,
  ExtensionPaneControls,
  ExtensionReviewReloadControls,
  ExtensionReviewNavigation,
} from "../../extension-api/types";
import { createEmptyExtensionLoadResult } from "../../extensions/types";
import { useExtensionEventContextProvider } from "./useExtensionEventContextProvider";

const dialogs = {} as ExtensionDialogs;
const navigation = {} as ExtensionReviewNavigation;
const panes = {} as ExtensionPaneControls;
const review = {} as ExtensionReviewReloadControls;
const createDialogs = () => dialogs;
const createNavigation = () => navigation;
const createPaneControls = () => panes;
const createReviewReloadControls = () => review;

/** Flush layout and passive work in an OpenTUI hook harness. */
async function settle(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

describe("useExtensionEventContextProvider", () => {
  test("installs before later layout effects, survives StrictMode replay, and cleans up", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const layoutObservations: boolean[] = [];

    function Harness() {
      useExtensionEventContextProvider({
        createDialogs,
        createNavigation,
        createPaneControls,
        createReviewReloadControls,
        extensions,
      });
      useLayoutEffect(() => {
        layoutObservations.push(Boolean(extensions.eventContextProvider));
      }, []);
      return <text>provider</text>;
    }

    const setup = await testRender(
      <StrictMode>
        <Harness />
      </StrictMode>,
      { width: 20, height: 2 },
    );
    await settle(setup);

    expect(layoutObservations.length).toBeGreaterThan(0);
    expect(layoutObservations.every(Boolean)).toBe(true);
    expect(extensions.eventContextProvider?.("probe")).toMatchObject({
      cwd: "/repo",
      dialogs,
      navigation,
      panes,
      sidebars: panes,
      review,
    });

    await act(async () => setup.renderer.destroy());
    expect(extensions.eventContextProvider).toBeUndefined();
  });

  test("registry replacement removes the retired provider and installs its successor", async () => {
    const first = createEmptyExtensionLoadResult("/repo/first");
    const second = createEmptyExtensionLoadResult("/repo/second");
    let replace!: () => void;

    function Harness() {
      const [extensions, setExtensions] = useState(first);
      replace = () => setExtensions(second);
      useExtensionEventContextProvider({
        createDialogs,
        createNavigation,
        createPaneControls,
        createReviewReloadControls,
        extensions,
      });
      return <text>{extensions.context.cwd}</text>;
    }

    const setup = await testRender(<Harness />, { width: 30, height: 2 });
    await settle(setup);
    const firstProvider = first.eventContextProvider;

    await act(async () => replace());
    await settle(setup);

    expect(first.eventContextProvider).toBeUndefined();
    expect(second.eventContextProvider).toBeDefined();
    expect(second.eventContextProvider).not.toBe(firstProvider);
    await act(async () => setup.renderer.destroy());
  });

  test("stale cleanup cannot clear a provider installed by a sibling", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    let removeFirst!: () => void;

    function Provider({ marker }: { marker: string }) {
      useExtensionEventContextProvider({
        createDialogs,
        createNavigation,
        createPaneControls,
        createReviewReloadControls,
        extensions,
      });
      return <text>{marker}</text>;
    }

    function Harness() {
      const [showFirst, setShowFirst] = useState(true);
      removeFirst = () => setShowFirst(false);
      return (
        <box>
          {showFirst ? <Provider marker="first" /> : null}
          <Provider marker="second" />
        </box>
      );
    }

    const setup = await testRender(<Harness />, { width: 30, height: 2 });
    await settle(setup);
    const successor = extensions.eventContextProvider;

    await act(async () => removeFirst());
    await settle(setup);

    expect(extensions.eventContextProvider).toBe(successor);
    await act(async () => setup.renderer.destroy());
  });
});

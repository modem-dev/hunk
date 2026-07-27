import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState, type ReactNode } from "react";
import { createTestDiffFile } from "../../../../test/helpers/diff-helpers";
import type {
  ExtensionSidebarActions,
  ExtensionSidebarViewProps,
} from "../../../extension-api/types";
import type { RegisteredSidebarView } from "../../../extensions/types";
import { resolveTheme } from "../../themes";
import { ExtensionSidebarPane } from "./ExtensionSidebarPane";

/** One registration object, the way each extension load pass produces a fresh one. */
function registeredView(component: (props: ExtensionSidebarViewProps) => ReactNode) {
  return {
    extensionId: "probe",
    view: { id: "probe-view", component },
  } as RegisteredSidebarView;
}

function createTestFiles() {
  return [
    createTestDiffFile({
      id: "alpha",
      path: "alpha.ts",
      before: "export const a = 1;\n",
      after: "export const a = 2;\n",
    }),
    createTestDiffFile({
      id: "beta",
      path: "beta.ts",
      before: "export const b = 1;\n",
      after: "export const b = 2;\n",
    }),
  ];
}

/** Mount one pane, run the body against the live render setup, and tear down. */
async function withPane(
  node: ReactNode,
  body: (setup: Awaited<ReturnType<typeof testRender>>) => Promise<void>,
) {
  const setup = await testRender(node, { width: 60, height: 20 });

  try {
    await act(async () => {
      await setup.renderOnce();
    });
    await body(setup);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

describe("ExtensionSidebarPane actions", () => {
  test("refuses garbage hunk indices and clamps the rest into the file's range", async () => {
    const files = createTestFiles();
    const theme = resolveTheme("github-dark-default", null);
    const notifications: string[] = [];
    const hunkSelections: Array<[string, number]> = [];
    let actions: ExtensionSidebarActions | undefined;

    await withPane(
      <ExtensionSidebarPane
        registered={registeredView((props) => {
          actions = props.actions;
          return <text content="probe" />;
        })}
        files={files}
        selectedFileId={null}
        selectedHunkIndex={null}
        showTopChrome={true}
        theme={theme}
        width={30}
        notify={(message) => notifications.push(message)}
        onSelectFile={() => {}}
        onSelectHunk={(fileId, hunkIndex) => hunkSelections.push([fileId, hunkIndex])}
      />,
      async () => {
        if (!actions) {
          throw new Error("The probe view never received its actions.");
        }

        // Selection state, reveal scrolling, and selection_changed all carry
        // the index, so a non-finite value must be refused outright...
        actions.selectHunk("alpha", Number.NaN);
        actions.selectHunk("alpha", Number.POSITIVE_INFINITY);
        expect(hunkSelections).toEqual([]);
        expect(notifications.filter((line) => line.includes("invalid hunk index"))).toHaveLength(2);

        // ...an unknown file refused with a warning...
        actions.selectHunk("missing", 0);
        expect(hunkSelections).toEqual([]);
        expect(notifications.some((line) => line.includes('unknown file id "missing"'))).toBe(true);

        // ...and out-of-range indices clamped into the file's real hunk range.
        const maxHunkIndex = files[0]!.metadata.hunks.length - 1;
        actions.selectHunk("alpha", 99);
        actions.selectHunk("alpha", -5);
        actions.selectHunk("alpha", 0.75);
        expect(hunkSelections).toEqual([
          ["alpha", maxHunkIndex],
          ["alpha", 0],
          ["alpha", 0],
        ]);
      },
    );
  });
});

describe("ExtensionSidebarPane failure recovery", () => {
  test("a fresh registration clears the failed boundary under unchanged ids", async () => {
    const files = createTestFiles();
    const theme = resolveTheme("github-dark-default", null);
    const notifications: string[] = [];
    const broken = registeredView(() => {
      throw new Error("sidebar exploded");
    });
    // Same extension and view ids, new object — exactly what reloading a fixed
    // extension produces, and what the id-keyed remount above cannot detect.
    const fixed = registeredView(() => <text content="FIXED VIEW" />);

    let swapRegistered: ((next: RegisteredSidebarView) => void) | undefined;
    function Harness() {
      const [registered, setRegistered] = useState(broken);
      swapRegistered = setRegistered;
      return (
        <ExtensionSidebarPane
          registered={registered}
          files={files}
          selectedFileId={null}
          selectedHunkIndex={null}
          showTopChrome={true}
          theme={theme}
          width={30}
          notify={(message) => notifications.push(message)}
          onSelectFile={() => {}}
          onSelectHunk={() => {}}
        />
      );
    }

    await withPane(<Harness />, async (setup) => {
      // The broken view fell back to the built-in sidebar and warned once.
      expect(setup.captureCharFrame()).toContain("alpha.ts");
      expect(notifications.some((line) => line.includes("failed rendering"))).toBe(true);

      await act(async () => {
        swapRegistered?.(fixed);
      });
      await act(async () => {
        await setup.renderOnce();
        await Bun.sleep(20);
        await setup.renderOnce();
      });

      // The reloaded registration rendered instead of staying pinned to the
      // fallback for the rest of the session.
      expect(setup.captureCharFrame()).toContain("FIXED VIEW");
    });
  });
});

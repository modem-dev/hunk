import { describe, expect, test } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act, useState, type ReactNode } from "react";
import { createTestDiffFile } from "../../../../../../test/helpers/diff-helpers";
import type {
  ExtensionPaneActions,
  ExtensionPaneKeybindings,
  ExtensionPaneProps,
} from "../../../extension-api/types";
import { toReadOnlyFileViews } from "../../../extensions/events";
import type { RegisteredPane } from "../../../extensions/types";
import { resolveTheme } from "../../themes";
import { ExtensionPaneHost } from "./ExtensionPane";

/** One registration object, the way each extension load pass produces a fresh one. */
function registeredView(component: (props: ExtensionPaneProps) => ReactNode) {
  return {
    extensionId: "probe",
    pane: { id: "probe-view", placement: "left", width: { preferred: 34, min: 22 }, component },
  } as unknown as RegisteredPane;
}

const TEST_KEYBINDINGS: ExtensionPaneKeybindings = {
  matches: () => false,
  getKeys: () => [],
};

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

describe("ExtensionPaneHost props", () => {
  test("passes the immutable delegated review descriptor to the component", async () => {
    const files = createTestFiles();
    const review = Object.freeze({
      kind: "change-request" as const,
      provider: "GitHub",
      title: "Metadata",
      id: "#1",
    });
    let received: ExtensionPaneProps["review"] | undefined;
    await withPane(
      <ExtensionPaneHost
        registered={registeredView((props) => {
          received = props.review;
          return <text content="probe" />;
        })}
        review={review}
        files={files}
        fileViews={toReadOnlyFileViews(files)}
        selectedFileId={null}
        selectedHunkIndex={null}
        theme={resolveTheme("github-dark-default", null)}
        width={30}
        height={10}
        placement="top"
        currentLine={null}
        keybindings={TEST_KEYBINDINGS}
        notify={() => {}}
        onSelectFile={() => {}}
        onSelectHunk={() => {}}
        onRevealLine={() => "line"}
      />,
      async () => {
        expect(received).toBe(review);
      },
    );
  });
});

describe("ExtensionPaneHost actions", () => {
  test("refuses garbage hunk indices and clamps the rest into the file's range", async () => {
    const files = createTestFiles();
    const theme = resolveTheme("github-dark-default", null);
    const notifications: string[] = [];
    const hunkSelections: Array<[string, number]> = [];
    let actions: ExtensionPaneActions | undefined;

    await withPane(
      <ExtensionPaneHost
        registered={registeredView((props) => {
          actions = props.actions;
          return <text content="probe" />;
        })}
        files={files}
        fileViews={toReadOnlyFileViews(files)}
        selectedFileId={null}
        selectedHunkIndex={null}
        showTopChrome={true}
        theme={theme}
        width={30}
        height={100}
        placement="left"
        currentLine={null}
        keybindings={TEST_KEYBINDINGS}
        notify={(message) => notifications.push(message)}
        onSelectFile={() => {}}
        onSelectHunk={(fileId, hunkIndex) => hunkSelections.push([fileId, hunkIndex])}
        onRevealLine={() => "line"}
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

describe("ExtensionPaneHost activation", () => {
  test("activates once through nested content without consuming its primary press", async () => {
    const files = createTestFiles();
    const theme = resolveTheme("github-dark-default", null);
    let activations = 0;
    let childPresses = 0;
    const registered = registeredView(() => (
      <scrollbox width="100%" height="100%" scrollY={true} focused={false}>
        <box
          style={{ width: "100%", height: 30 }}
          onMouseDown={() => {
            childPresses += 1;
          }}
        >
          <text content="nested target" />
        </box>
      </scrollbox>
    ));
    registered.pane.onActivate = () => {
      activations += 1;
    };

    await withPane(
      <ExtensionPaneHost
        registered={registered}
        files={files}
        fileViews={toReadOnlyFileViews(files)}
        selectedFileId={null}
        selectedHunkIndex={null}
        showTopChrome={true}
        theme={theme}
        width={30}
        height={20}
        placement="left"
        currentLine={null}
        keybindings={TEST_KEYBINDINGS}
        notify={() => {}}
        onSelectFile={() => {}}
        onSelectHunk={() => {}}
        onRevealLine={() => "line"}
      />,
      async (setup) => {
        await act(async () => setup.mockMouse.click(2, 0, MouseButtons.LEFT));
        expect(activations).toBe(1);
        expect(childPresses).toBe(1);

        await act(async () => setup.mockMouse.click(2, 0, MouseButtons.RIGHT));
        expect(activations).toBe(1);
        expect(childPresses).toBe(2);
      },
    );
  });

  test("contains synchronous and asynchronous activation failures", async () => {
    const files = createTestFiles();
    const theme = resolveTheme("github-dark-default", null);
    const notifications: string[] = [];
    const failures = [new Error("sync exploded"), new Error("async exploded")];
    const registered = registeredView(() => <text content="activate" />);
    registered.pane.onActivate = () => {
      const failure = failures.shift();
      if (!failure) return;
      if (failure.message.startsWith("async")) return Promise.reject(failure) as unknown as void;
      throw failure;
    };

    await withPane(
      <ExtensionPaneHost
        registered={registered}
        files={files}
        fileViews={toReadOnlyFileViews(files)}
        selectedFileId={null}
        selectedHunkIndex={null}
        showTopChrome={true}
        theme={theme}
        width={30}
        height={20}
        placement="left"
        currentLine={null}
        keybindings={TEST_KEYBINDINGS}
        notify={(message) => notifications.push(message)}
        onSelectFile={() => {}}
        onSelectHunk={() => {}}
        onRevealLine={() => "line"}
      />,
      async (setup) => {
        await act(async () => setup.mockMouse.click(1, 0, MouseButtons.LEFT));
        await act(async () => setup.mockMouse.click(1, 0, MouseButtons.LEFT));
        await Promise.resolve();

        expect(notifications).toHaveLength(2);
        expect(notifications[0]).toContain('pane "probe-view" activation failed • sync exploded');
        expect(notifications[1]).toContain('pane "probe-view" activation failed • async exploded');
      },
    );
  });
});

describe("ExtensionPaneHost failure recovery", () => {
  test("the bundled files pane has a renderer-independent safe fallback", async () => {
    const files = createTestFiles();
    const theme = resolveTheme("github-dark-default", null);
    const notifications: string[] = [];
    const registered: RegisteredPane = {
      extensionId: "hunk",
      pane: {
        id: "files",
        placement: "left",
        width: { preferred: 34, min: 22 },
        component: () => {
          throw new Error("files exploded");
        },
      },
    };

    await withPane(
      <ExtensionPaneHost
        registered={registered}
        files={files}
        fileViews={toReadOnlyFileViews(files)}
        selectedFileId={null}
        selectedHunkIndex={null}
        showTopChrome={true}
        theme={theme}
        width={30}
        height={20}
        placement="left"
        currentLine={null}
        keybindings={TEST_KEYBINDINGS}
        notify={(message) => notifications.push(message)}
        onSelectFile={() => {}}
        onSelectHunk={() => {}}
        onRevealLine={() => "line"}
      />,
      async (setup) => {
        expect(setup.captureCharFrame()).toContain("Files pane unavailable");
        expect(notifications.some((line) => line.includes("failed rendering"))).toBe(true);
        expect(notifications.some((line) => line.includes("using the built-in files pane"))).toBe(
          false,
        );
      },
    );
  });

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

    let swapRegistered: ((next: RegisteredPane) => void) | undefined;
    function Harness() {
      const [registered, setRegistered] = useState(broken);
      swapRegistered = setRegistered;
      return (
        <ExtensionPaneHost
          registered={registered}
          files={files}
          fileViews={toReadOnlyFileViews(files)}
          selectedFileId={null}
          selectedHunkIndex={null}
          showTopChrome={true}
          theme={theme}
          width={30}
          height={100}
          placement="left"
          currentLine={null}
          keybindings={TEST_KEYBINDINGS}
          notify={(message) => notifications.push(message)}
          onSelectFile={() => {}}
          onSelectHunk={() => {}}
          onRevealLine={() => "line"}
        />
      );
    }

    await withPane(<Harness />, async (setup) => {
      // The broken view fell back to the built-in sidebar and warned once.
      expect(setup.captureCharFrame()).toContain("alpha.ts");
      expect(notifications.some((line) => line.includes("failed rendering"))).toBe(true);
      expect(notifications.some((line) => line.includes("using the built-in files pane"))).toBe(
        true,
      );

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

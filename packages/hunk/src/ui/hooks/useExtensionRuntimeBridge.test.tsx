import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, StrictMode, useState } from "react";
import { createTestVcsAppBootstrap } from "../../../../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { createTestReviewState } from "../../../../../test/helpers/review-store-helpers";
import type { AppBootstrap } from "../../core/bootstrap";
import type { DiffFile } from "../../core/changeset/model";
import { createEmptyExtensionLoadResult, type ExtensionLoadResult } from "../../extensions/types";
import type { AppCommand } from "../lib/appCommands";
import {
  useExtensionRuntimeBindings,
  useExtensionRuntimeBridge,
  type ExtensionRuntimeBridge,
} from "./useExtensionRuntimeBridge";

interface RuntimeFacts {
  extensions: ExtensionLoadResult;
  files: DiffFile[];
  reviewGeneration: AppBootstrap;
  selectedFileId: string | null;
  selectedHunkIndex: number | null;
}

/** Build one public host command for command-control liveness tests. */
function createTestCommand(run: () => void): AppCommand {
  return {
    id: "hunk.test.run",
    title: "Run test command",
    keys: [],
    keyLabels: [],
    match: () => false,
    publicToExtensions: true,
    run,
  };
}

/** Mount the runtime bridge with mutable registry, review, and selection facts. */
async function renderRuntime(initialFacts: RuntimeFacts, strict = false) {
  let runtime!: ExtensionRuntimeBridge;
  let updateFacts!: (update: Partial<RuntimeFacts>) => void;
  const navigationCalls: string[] = [];
  let commandRuns = 0;
  const commands = [createTestCommand(() => commandRuns++)];
  const reviewState = createTestReviewState([
    { key: "alpha", path: "alpha.ts", contentIdentity: "sha256:alpha" },
  ]);

  function Harness() {
    const [facts, setFacts] = useState(initialFacts);
    updateFacts = (update) => setFacts((current) => ({ ...current, ...update }));
    runtime = useExtensionRuntimeBridge({
      extensions: facts.extensions,
      files: facts.files,
      getActiveLineCursor: () => null,
      getSelection: () => ({
        fileId: facts.selectedFileId,
        hunkIndex: facts.selectedHunkIndex,
      }),
      reviewGeneration: facts.reviewGeneration,
      reviewProducer: {
        getPositionedReviewState: () => ({
          generation: facts.reviewGeneration.changeset.id,
          state: reviewState,
        }),
      },
    });
    useExtensionRuntimeBindings({
      commands,
      navigation: {
        // Mark calls with this render's selection so tests distinguish committed callback updates.
        onSelectFile: (fileId) =>
          navigationCalls.push(`selection:${facts.selectedFileId}:file:${fileId}`),
        onSelectHunk: (fileId, hunkIndex) =>
          navigationCalls.push(`selection:${facts.selectedFileId}:hunk:${fileId}:${hunkIndex}`),
        onRevealLine: (fileId, side, line) => {
          navigationCalls.push(`selection:${facts.selectedFileId}:line:${fileId}:${side}:${line}`);
          return "line";
        },
      },
      runtime,
    });
    return <text>{facts.selectedFileId ?? "none"}</text>;
  }

  const tree = <Harness />;
  const setup = await testRender(strict ? <StrictMode>{tree}</StrictMode> : tree, {
    width: 40,
    height: 2,
  });
  const settle = async () => {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(0);
      await setup.renderOnce();
    });
  };
  await settle();

  return {
    commandRuns: () => commandRuns,
    current: () => runtime,
    navigationCalls,
    settle,
    setup,
    updateFacts,
  };
}

/** Build one bootstrap identity for review-generation authority tests. */
function createBootstrap(id: string): AppBootstrap {
  return createTestVcsAppBootstrap({
    changesetId: id,
    files: [createTestDiffFile({ id: "alpha", path: "alpha.ts" })],
    initialMode: "stack",
  });
}

/** Destroy a mounted runtime harness. */
async function destroy(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => setup.renderer.destroy());
}

describe("useExtensionRuntimeBridge", () => {
  test("restores authority after StrictMode replay and revokes it during layout cleanup", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const bootstrap = createBootstrap("runtime:strict");
    const file = bootstrap.changeset.files[0]!;
    const harness = await renderRuntime(
      {
        extensions,
        files: [file],
        reviewGeneration: bootstrap,
        selectedFileId: file.id,
        selectedHunkIndex: 0,
      },
      true,
    );
    const controls = harness.current().commandControls;

    expect(controls.isEnabled("hunk.test.run")).toBe(true);
    expect(controls.execute("hunk.test.run")).toBe(true);
    expect(harness.commandRuns()).toBe(1);

    await destroy(harness.setup);
    expect(controls.isEnabled("hunk.test.run")).toBe(false);
    expect(controls.execute("hunk.test.run")).toBe(false);
  });

  test("hard remount retires predecessor controls while the same-registry successor stays live", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const first = createBootstrap("runtime:hard:first");
    const second = createBootstrap("runtime:hard:second");
    const runtimes = new Map<string, ExtensionRuntimeBridge>();
    let mountSuccessor!: () => void;
    let commandRuns = 0;
    const commands = [createTestCommand(() => commandRuns++)];

    function RuntimeInstance({ generation }: { generation: AppBootstrap }) {
      const runtime = useExtensionRuntimeBridge({
        extensions,
        files: generation.changeset.files,
        getActiveLineCursor: () => null,
        getSelection: () => ({ fileId: "alpha", hunkIndex: 0 }),
        reviewGeneration: generation,
      });
      useExtensionRuntimeBindings({
        commands,
        navigation: {
          onSelectFile: () => {},
          onSelectHunk: () => {},
          onRevealLine: () => "line",
        },
        runtime,
      });
      runtimes.set(generation.changeset.id, runtime);
      return <text>{generation.changeset.id}</text>;
    }

    function Harness() {
      const [successor, setSuccessor] = useState(false);
      mountSuccessor = () => setSuccessor(true);
      const generation = successor ? second : first;
      return <RuntimeInstance key={generation.changeset.id} generation={generation} />;
    }

    const setup = await testRender(<Harness />, { width: 40, height: 2 });
    const settle = async () => {
      await act(async () => {
        await setup.renderOnce();
        await Bun.sleep(0);
        await setup.renderOnce();
      });
    };
    await settle();
    const predecessorControls = runtimes.get(first.changeset.id)!.commandControls;
    expect(predecessorControls.isEnabled("hunk.test.run")).toBe(true);

    await act(async () => mountSuccessor());
    await settle();

    const successorControls = runtimes.get(second.changeset.id)!.commandControls;
    expect(predecessorControls.isEnabled("hunk.test.run")).toBe(false);
    expect(predecessorControls.execute("hunk.test.run")).toBe(false);
    expect(successorControls.isEnabled("hunk.test.run")).toBe(true);
    expect(successorControls.execute("hunk.test.run")).toBe(true);
    expect(commandRuns).toBe(1);
    await destroy(setup);
  });

  test("keeps runtime commands across content reloads while expiring review-bound controls", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const first = createBootstrap("runtime:first");
    const second = createBootstrap("runtime:second");
    const harness = await renderRuntime({
      extensions,
      files: first.changeset.files,
      reviewGeneration: first,
      selectedFileId: "alpha",
      selectedHunkIndex: 0,
    });

    try {
      const commandControls = harness.current().commandControls;
      const predecessorLease = harness.current().createReviewCapabilityLease();
      const predecessorNavigation = harness.current().createNavigation("probe");
      const predecessorReview = harness.current().createReviewControls();
      expect(predecessorReview.snapshot()?.generation).toBe(first.changeset.id);

      await act(async () =>
        harness.updateFacts({
          files: second.changeset.files,
          reviewGeneration: second,
        }),
      );
      await harness.settle();

      expect(commandControls.isEnabled("hunk.test.run")).toBe(true);
      expect(predecessorLease.isLive()).toBe(false);
      expect(predecessorReview.snapshot()).toBeNull();
      predecessorNavigation.selectFile("alpha");
      expect(harness.navigationCalls).toEqual([]);

      const successorLease = harness.current().createReviewCapabilityLease();
      const successorNavigation = harness.current().createNavigation("probe");
      const successorReview = harness.current().createReviewControls();
      expect(successorLease.isLive()).toBe(true);
      expect(successorReview.snapshot()?.generation).toBe(second.changeset.id);
      successorNavigation.selectFile("alpha");
      expect(harness.navigationCalls).toEqual(["selection:alpha:file:alpha"]);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("retires controls from a replaced registry without letting them drive its successor", async () => {
    const firstExtensions = createEmptyExtensionLoadResult("/repo/first");
    const secondExtensions = createEmptyExtensionLoadResult("/repo/second");
    const bootstrap = createBootstrap("runtime:registry");
    const harness = await renderRuntime({
      extensions: firstExtensions,
      files: bootstrap.changeset.files,
      reviewGeneration: bootstrap,
      selectedFileId: "alpha",
      selectedHunkIndex: 0,
    });

    try {
      const stale = harness.current().commandControls;
      await act(async () => harness.updateFacts({ extensions: secondExtensions }));
      await harness.settle();

      expect(stale.isEnabled("hunk.test.run")).toBe(false);
      expect(harness.current().commandControls.isEnabled("hunk.test.run")).toBe(true);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("freezes invocation selection while navigation reads the latest committed bindings", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const bootstrap = createBootstrap("runtime:live");
    const alpha = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const beta = createTestDiffFile({ id: "beta", path: "beta.ts" });
    const harness = await renderRuntime({
      extensions,
      files: [alpha, beta],
      reviewGeneration: bootstrap,
      selectedFileId: "alpha",
      selectedHunkIndex: 0,
    });

    try {
      const selection = harness.current().getSelection();
      const navigation = harness.current().createNavigation("probe");

      await act(async () =>
        harness.updateFacts({
          files: [beta],
          selectedFileId: "beta",
          selectedHunkIndex: 0,
        }),
      );
      await harness.settle();

      expect(selection.file?.id).toBe("alpha");
      expect(Object.isFrozen(selection)).toBe(true);
      expect(Object.isFrozen(selection.file)).toBe(true);
      navigation.selectFile("beta");
      expect(harness.navigationCalls).toEqual(["selection:beta:file:beta"]);
    } finally {
      await destroy(harness.setup);
    }
  });
});

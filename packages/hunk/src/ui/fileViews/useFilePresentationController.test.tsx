import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useCallback, useMemo, useRef, useState } from "react";
import type { DiffFile } from "../../core/changeset/model";
import { toReadOnlyFileViews } from "../../extensions/events";
import type { RegisteredFileView } from "../../extensions/types";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { buildExtensionReviewSelection } from "../lib/extensionSelection";
import { registeredFileViewKey } from "./state";
import { useFilePresentationController } from "./useFilePresentationController";

interface HarnessState {
  files: DiffFile[];
  visibleFileIds: string[];
  selectedFileId: string | null;
  draftFileId: string | null;
  views: RegisteredFileView[];
}

/** Build one registered view with deterministic matching for controller tests. */
function createTestView({
  extensionId = "probe",
  id = "preview",
  title = "Preview",
  matches = () => true,
  mode,
}: {
  extensionId?: string;
  id?: string;
  title?: string;
  matches?: RegisteredFileView["view"]["matches"];
  mode?: RegisteredFileView["view"]["mode"];
} = {}): RegisteredFileView {
  return {
    extensionId,
    view: {
      id,
      title,
      matches,
      layout: () => null,
      mode,
    },
  };
}

/** Mount the controller with replaceable review inputs and live extension getters. */
async function renderController(initial: HarnessState) {
  let controller!: ReturnType<typeof useFilePresentationController>;
  let update!: (next: Partial<HarnessState>) => void;
  const notices: string[] = [];

  function Harness() {
    const [state, setState] = useState(initial);
    update = (next) => setState((current) => ({ ...current, ...next }));
    const visibleFiles = useMemo(
      () => state.files.filter((file) => state.visibleFileIds.includes(file.id)),
      [state.files, state.visibleFileIds],
    );
    const visibleFileViews = useMemo(() => toReadOnlyFileViews(visibleFiles), [visibleFiles]);
    const live = useRef({ state, visibleFileViews });
    live.current = { state, visibleFileViews };
    const getVisibleFileViews = useCallback(() => live.current.visibleFileViews, []);
    const getSelectedFileId = useCallback(() => live.current.state.selectedFileId, []);
    const getExtensionSelection = useCallback(
      () =>
        buildExtensionReviewSelection({
          files: live.current.visibleFileViews,
          selectedFileId: live.current.state.selectedFileId,
          selectedHunkIndex: 0,
          lineCursor: null,
        }),
      [],
    );
    const showNotice = useCallback((message: string) => notices.push(message), []);
    controller = useFilePresentationController({
      files: state.files,
      visibleFiles,
      selectedFile: state.files.find((file) => file.id === state.selectedFileId),
      draftFileId: state.draftFileId,
      views: state.views,
      getVisibleFileViews,
      getSelectedFileId,
      getExtensionSelection,
      showNotice,
      cwd: "/repo",
      notify: (message) => notices.push(message),
      reviewGeneration: state.files,
    });
    return null;
  }

  const setup = await testRender(<Harness />, { width: 40, height: 4 });
  await act(async () => setup.renderOnce());
  return {
    setup,
    controller: () => controller,
    notices,
    update: (next: Partial<HarnessState>) => update(next),
  };
}

/** Return one selectable menu item by its stable command id. */
function menuItem(controller: ReturnType<typeof useFilePresentationController>, commandId: string) {
  const entry = controller.menuEntries.find(
    (candidate) => candidate.kind === "item" && candidate.commandId === commandId,
  );
  if (!entry || entry.kind !== "item") throw new Error(`Missing menu item ${commandId}`);
  return entry;
}

/** Report whether one presentation is checked for the selected file. */
function presentationChecked(
  controller: ReturnType<typeof useFilePresentationController>,
  key: string,
) {
  return menuItem(controller, `hunk.view.filePresentation.${key}`).checked;
}

describe("useFilePresentationController", () => {
  test("keeps a selected presentation through filtering and reconciles files and views on reload", async () => {
    const alpha = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const beta = createTestDiffFile({ id: "beta", path: "beta.ts" });
    const preview = createTestView();
    const key = registeredFileViewKey(preview);
    const harness = await renderController({
      files: [alpha, beta],
      visibleFileIds: ["alpha", "beta"],
      selectedFileId: "beta",
      draftFileId: null,
      views: [preview],
    });

    try {
      await act(async () =>
        menuItem(harness.controller(), `hunk.view.filePresentation.${key}`).action(),
      );
      expect(presentationChecked(harness.controller(), key)).toBe(true);

      // A real visible-to-hidden transition must not erase the hidden file's stored choice.
      await act(async () => harness.update({ visibleFileIds: ["alpha"], selectedFileId: "alpha" }));
      const reloadedAlpha = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
      const reloadedBeta = createTestDiffFile({ id: "beta", path: "beta.ts" });
      const reloadedPreview = createTestView();
      await act(async () =>
        harness.update({ files: [reloadedAlpha, reloadedBeta], views: [reloadedPreview] }),
      );
      await act(async () =>
        harness.update({ visibleFileIds: ["alpha", "beta"], selectedFileId: "beta" }),
      );
      expect(presentationChecked(harness.controller(), key)).toBe(true);

      // Removing a file drops its choice; adding a stable-id replacement later starts raw.
      await act(async () =>
        harness.update({
          files: [reloadedAlpha],
          visibleFileIds: ["alpha"],
          selectedFileId: "alpha",
        }),
      );
      await act(async () =>
        harness.update({
          files: [reloadedAlpha, reloadedBeta],
          visibleFileIds: ["alpha", "beta"],
          selectedFileId: "beta",
        }),
      );
      expect(menuItem(harness.controller(), "hunk.view.filePresentation.raw").checked).toBe(true);

      await act(async () =>
        menuItem(harness.controller(), `hunk.view.filePresentation.${key}`).action(),
      );
      await act(async () => harness.update({ views: [] }));
      await act(async () => harness.update({ views: [reloadedPreview] }));
      expect(menuItem(harness.controller(), "hunk.view.filePresentation.raw").checked).toBe(true);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("temporarily masks a draft file and restores its stored selection", async () => {
    const alpha = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const preview = createTestView();
    const key = registeredFileViewKey(preview);
    const harness = await renderController({
      files: [alpha],
      visibleFileIds: ["alpha"],
      selectedFileId: "alpha",
      draftFileId: null,
      views: [preview],
    });

    try {
      await act(async () =>
        menuItem(harness.controller(), `hunk.view.filePresentation.${key}`).action(),
      );
      expect(harness.controller().availableSelections).toEqual({ alpha: key });

      await act(async () => harness.update({ draftFileId: "alpha" }));
      expect(harness.controller().availableSelections).toEqual({});
      expect(harness.controller().menuEntries).toHaveLength(1);
      expect(menuItem(harness.controller(), "hunk.view.filePresentation.raw").checked).toBe(true);

      await act(async () => harness.update({ draftFileId: null }));
      expect(harness.controller().availableSelections).toEqual({ alpha: key });
      expect(presentationChecked(harness.controller(), key)).toBe(true);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("keeps raw implicit even when an extension view is literally named raw", async () => {
    const alpha = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const rawNamedView = createTestView({ id: "raw", title: "Extension raw" });
    const key = registeredFileViewKey(rawNamedView);
    const harness = await renderController({
      files: [alpha],
      visibleFileIds: ["alpha"],
      selectedFileId: "alpha",
      draftFileId: null,
      views: [rawNamedView],
    });

    try {
      await act(async () =>
        menuItem(harness.controller(), `hunk.view.filePresentation.${key}`).action(),
      );
      expect(presentationChecked(harness.controller(), key)).toBe(true);
      expect(menuItem(harness.controller(), "hunk.view.filePresentation.raw").checked).toBe(false);

      await act(async () =>
        menuItem(harness.controller(), "hunk.view.filePresentation.raw").action(),
      );
      expect(menuItem(harness.controller(), "hunk.view.filePresentation.raw").checked).toBe(true);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("applies a presentation to filter-hidden matches without touching nonmatches", async () => {
    const alpha = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const beta = createTestDiffFile({ id: "beta", path: "beta.ts" });
    const notes = createTestDiffFile({ id: "notes", path: "notes.md" });
    const preview = createTestView({ matches: (file) => file.path.endsWith(".ts") });
    const key = registeredFileViewKey(preview);
    const harness = await renderController({
      files: [alpha, beta, notes],
      visibleFileIds: ["alpha"],
      selectedFileId: "alpha",
      draftFileId: null,
      views: [preview],
    });

    try {
      await act(async () =>
        menuItem(harness.controller(), `hunk.view.filePresentation.${key}`).action(),
      );
      expect(harness.controller().bulkTarget).toEqual({ title: "Preview" });

      await act(async () => harness.controller().applyBulkTarget());
      expect(harness.controller().bulkTarget).toBeNull();
      await act(async () =>
        harness.update({ visibleFileIds: ["alpha", "beta", "notes"], selectedFileId: "beta" }),
      );
      expect(presentationChecked(harness.controller(), key)).toBe(true);
      await act(async () => harness.update({ selectedFileId: "notes" }));
      expect(menuItem(harness.controller(), "hunk.view.filePresentation.raw").checked).toBe(true);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("omits nonmatching and throwing views from the selected-file menu", async () => {
    const alpha = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const matching = createTestView({ id: "matching", title: "Matching" });
    const nonmatching = createTestView({ id: "nope", matches: () => false });
    const throwing = createTestView({
      id: "broken",
      matches: () => {
        throw new Error("matcher exploded");
      },
    });
    const harness = await renderController({
      files: [alpha],
      visibleFileIds: ["alpha"],
      selectedFileId: "alpha",
      draftFileId: null,
      views: [matching, nonmatching, throwing],
    });

    try {
      expect(
        harness
          .controller()
          .menuEntries.map((entry) => (entry.kind === "item" ? entry.label : "separator")),
      ).toEqual(["File presentation: Raw diff", "File presentation: Matching"]);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("keeps extension controls live across selection and draft updates", async () => {
    const alpha = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const beta = createTestDiffFile({ id: "beta", path: "beta.ts" });
    const preview = createTestView();
    const harness = await renderController({
      files: [alpha, beta],
      visibleFileIds: ["alpha", "beta"],
      selectedFileId: "alpha",
      draftFileId: null,
      views: [preview],
    });
    const createControls = harness.controller().createControls;
    const controls = createControls("probe");

    try {
      await act(async () => controls.select("preview"));
      expect(controls.isActive("preview")).toBe(true);
      expect(harness.controller().createControls).toBe(createControls);

      await act(async () => harness.update({ selectedFileId: "beta" }));
      expect(harness.controller().createControls).toBe(createControls);
      expect(controls.isActive("preview")).toBe(false);
      await act(async () => controls.select("preview"));
      expect(controls.isActive("preview")).toBe(true);

      await act(async () => harness.update({ selectedFileId: "alpha", draftFileId: "alpha" }));
      expect(controls.isActive("preview")).toBe(false);
      await act(async () => controls.toggle("preview"));
      expect(harness.notices).toEqual([
        "File presentations are unavailable while drafting an inline review note • using raw diff",
      ]);

      await act(async () => harness.update({ draftFileId: null }));
      expect(controls.isActive("preview")).toBe(true);
      await act(async () => controls.toggle("preview"));
      expect(controls.isActive("preview")).toBe(false);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("refuses mode entry from controls that outlived a hard remount", async () => {
    const alpha = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    let enterCalls = 0;
    const preview = createTestView({
      mode: {
        onEnter: () => {
          enterCalls += 1;
        },
        onKey: () => "handled",
      },
    });
    const harness = await renderController({
      files: [alpha],
      visibleFileIds: ["alpha"],
      selectedFileId: "alpha",
      draftFileId: null,
      views: [preview],
    });
    const controls = harness.controller().createControls("probe");

    await act(async () => harness.setup.renderer.destroy());

    expect(controls.enterMode("preview")).toBe(false);
    expect(enterCalls).toBe(0);
    expect(harness.notices.at(-1)).toBe(
      "Extension probe cannot enter a mode after its review session closed",
    );
  });

  test("preserves a mode entered re-entrantly from the outgoing mode's onExit", async () => {
    const alpha = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const events: string[] = [];
    const alphaView = createTestView({
      id: "alpha-view",
      mode: {
        onExit: (ctx) => {
          events.push("exit alpha");
          ctx.fileViews.enterMode("gamma-view");
        },
        onKey: () => "handled",
      },
    });
    const betaView = createTestView({
      id: "beta-view",
      mode: {
        onEnter: () => events.push("enter beta"),
        onKey: () => "handled",
      },
    });
    const gammaView = createTestView({
      id: "gamma-view",
      mode: {
        onEnter: () => events.push("enter gamma"),
        onKey: () => "handled",
      },
    });
    const harness = await renderController({
      files: [alpha],
      visibleFileIds: ["alpha"],
      selectedFileId: "alpha",
      draftFileId: null,
      views: [alphaView, betaView, gammaView],
    });
    const controls = harness.controller().createControls("probe");

    try {
      await act(async () => expect(controls.enterMode("alpha-view")).toBe(true));
      let enteredBeta = true;
      await act(async () => {
        enteredBeta = controls.enterMode("beta-view");
      });

      expect(enteredBeta).toBe(false);
      expect(controls.isModeActive("gamma-view")).toBe(true);
      expect(events).toEqual(["exit alpha", "enter gamma"]);
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("does not exit a replacement mode when the outgoing onEnter throws", async () => {
    const alpha = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const events: string[] = [];
    const alphaView = createTestView({
      id: "alpha-view",
      mode: {
        onEnter: (ctx) => {
          events.push("enter alpha");
          ctx.fileViews.enterMode("beta-view");
          throw new Error("alpha enter failed");
        },
        onExit: () => events.push("exit alpha"),
        onKey: () => "handled",
      },
    });
    const betaView = createTestView({
      id: "beta-view",
      mode: {
        onEnter: () => events.push("enter beta"),
        onKey: () => "handled",
      },
    });
    const harness = await renderController({
      files: [alpha],
      visibleFileIds: ["alpha"],
      selectedFileId: "alpha",
      draftFileId: null,
      views: [alphaView, betaView],
    });
    const controls = harness.controller().createControls("probe");

    try {
      await act(async () => expect(controls.enterMode("alpha-view")).toBe(false));

      expect(controls.isModeActive("beta-view")).toBe(true);
      expect(events).toEqual(["enter alpha", "exit alpha", "enter beta"]);
      expect(harness.notices.join("\n")).toContain("failed onEnter • alpha enter failed");
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });

  test("reports every extension-control refusal without mutating the presentation", async () => {
    const alpha = createTestDiffFile({ id: "alpha", path: "alpha.ts" });
    const matching = createTestView();
    const markdown = createTestView({
      id: "markdown",
      matches: (file) => file.path.endsWith(".md"),
    });
    const throwing = createTestView({
      id: "broken",
      matches: () => {
        throw new Error("matcher exploded");
      },
    });
    const harness = await renderController({
      files: [alpha],
      visibleFileIds: ["alpha"],
      selectedFileId: null,
      draftFileId: null,
      views: [matching, markdown, throwing],
    });
    const controls = harness.controller().createControls("probe");

    try {
      await act(async () => controls.select("preview"));
      await act(async () => harness.update({ selectedFileId: "alpha" }));
      await act(async () => controls.select("missing"));
      await act(async () => controls.select("markdown"));
      await act(async () => controls.select("broken"));
      expect(harness.notices).toEqual([
        "Extension probe cannot select a file view without a selected file",
        'Extension probe targeted unknown file view "missing"',
        'File view "markdown" does not match the selected file • using raw diff',
        'Extension probe file view "broken" failed matching the selected file',
      ]);
      expect(menuItem(harness.controller(), "hunk.view.filePresentation.raw").checked).toBe(true);

      // The controls resolve registrations at invocation rather than capturing the first set.
      const replacement = createTestView({ id: "replacement" });
      await act(async () => harness.update({ views: [replacement] }));
      await act(async () => controls.select("replacement"));
      expect(controls.isActive("replacement")).toBe(true);

      // The internal id is live even when the frozen public selection is temporarily absent.
      await act(async () => harness.update({ selectedFileId: "alpha", visibleFileIds: [] }));
      await act(async () => controls.select("replacement"));
      expect(harness.notices.at(-1)).toBe(
        'File view "replacement" does not match the selected file • using raw diff',
      );
    } finally {
      await act(async () => harness.setup.renderer.destroy());
    }
  });
});

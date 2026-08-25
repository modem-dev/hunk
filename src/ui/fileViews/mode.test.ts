import { describe, expect, test } from "bun:test";
import type {
  ExtensionDiffFile,
  ExtensionFileViewMode,
  ExtensionFileViewModeContext,
} from "../../extension-api/types";
import type { RegisteredFileView } from "../../extensions/types";
import {
  deliverFileViewModeKey,
  fileViewModeStatusHint,
  fileViewModeStillValid,
  resolveFileViewModeActivation,
  runFileViewModeLifecycle,
  type ActiveFileViewMode,
} from "./mode";

/** Build a registration whose view optionally carries an interactive mode. */
function createTestRegisteredFileView(
  mode?: ExtensionFileViewMode,
  matches: (file: ExtensionDiffFile) => boolean = () => true,
): RegisteredFileView {
  return {
    extensionId: "preview",
    view: {
      id: "rendered",
      title: "Rendered",
      matches,
      layout: () => null,
      mode,
    },
  };
}

/** The selected file every activation is resolved against. */
const testActivationFile = { id: "readme", path: "README.md" } as unknown as ExtensionDiffFile;

/** Build the active-mode record the host routes keys against. */
function createTestActiveMode(
  mode: ExtensionFileViewMode,
  overrides: Partial<ActiveFileViewMode> = {},
): ActiveFileViewMode {
  const registered = createTestRegisteredFileView(mode);
  const ctx = {
    cwd: "/repo",
    notify: () => {},
    file: { id: "readme", path: "README.md" } as unknown as ExtensionDiffFile,
    fileViews: {} as ExtensionFileViewModeContext["fileViews"],
  } satisfies ExtensionFileViewModeContext;
  return {
    ctx,
    extensionId: "preview",
    fileId: "readme",
    mode,
    registered,
    reviewGeneration: "generation-1",
    viewId: "rendered",
    viewKey: "preview:rendered",
    ...overrides,
  };
}

describe("file-view mode state", () => {
  test("names each refusal enterMode can answer with", () => {
    const mode: ExtensionFileViewMode = { onKey: () => "handled" };
    const registered = createTestRegisteredFileView(mode);
    const activation = {
      activeViewKey: "preview:rendered",
      extensionId: "preview",
      file: testActivationFile,
      unavailableReason: undefined,
      viewId: "rendered",
    };

    expect(
      resolveFileViewModeActivation({
        ...activation,
        registered: undefined,
        viewId: "missing",
      }),
    ).toEqual({
      ok: false,
      refusal: 'Extension preview targeted unknown file view "missing"',
    });

    expect(
      resolveFileViewModeActivation({
        ...activation,
        activeViewKey: "preview:plain",
        registered: createTestRegisteredFileView(),
      }),
    ).toEqual({
      ok: false,
      refusal: 'Extension preview file view "rendered" has no interactive mode',
    });

    // Nothing to enter a mode on, and nothing a selection could fix.
    expect(resolveFileViewModeActivation({ ...activation, file: null, registered })).toEqual({
      ok: false,
      refusal: "Extension preview cannot enter a mode without a selected file",
    });

    // The containment `select` applies: a view that does not claim the file
    // cannot become its presentation, so its mode cannot take the keyboard.
    expect(
      resolveFileViewModeActivation({
        ...activation,
        activeViewKey: null,
        registered: createTestRegisteredFileView(mode, () => false),
      }),
    ).toEqual({
      ok: false,
      refusal: 'File view "rendered" does not match the selected file • using raw diff',
    });

    expect(
      resolveFileViewModeActivation({
        ...activation,
        activeViewKey: null,
        registered: createTestRegisteredFileView(mode, () => {
          throw new Error("matcher exploded");
        }),
      }),
    ).toEqual({
      ok: false,
      refusal: 'Extension preview file view "rendered" failed matching the selected file',
    });

    // A file the host is keeping on raw diff refuses with the host's reason.
    expect(
      resolveFileViewModeActivation({
        ...activation,
        registered,
        unavailableReason: "File presentations are unavailable • using raw diff",
      }),
    ).toEqual({
      ok: false,
      refusal: "File presentations are unavailable • using raw diff",
    });
  });

  test("enters in one step, selecting the view when it is not yet the presentation", () => {
    const mode: ExtensionFileViewMode = { onKey: () => "handled" };
    const registered = createTestRegisteredFileView(mode);
    const activation = {
      extensionId: "preview",
      file: testActivationFile,
      registered,
      unavailableReason: undefined,
      viewId: "rendered",
    };

    // Already on screen: nothing to select, exactly as before.
    expect(
      resolveFileViewModeActivation({ ...activation, activeViewKey: "preview:rendered" }),
    ).toEqual({ ok: true, registered, mode, select: null });

    // Raw diff, or another view: entering carries the selection that makes the
    // mode's rows visible instead of refusing and asking for a second press.
    expect(resolveFileViewModeActivation({ ...activation, activeViewKey: null })).toEqual({
      ok: true,
      registered,
      mode,
      select: { fileId: "readme", viewKey: "preview:rendered" },
    });
    expect(
      resolveFileViewModeActivation({ ...activation, activeViewKey: "preview:plain" }),
    ).toEqual({
      ok: true,
      registered,
      mode,
      select: { fileId: "readme", viewKey: "preview:rendered" },
    });
  });

  test("holds a mode only while the review still matches what it was entered on", () => {
    const active = createTestActiveMode({ onKey: () => "handled" });
    const valid = {
      activeViewKey: "preview:rendered",
      reviewGeneration: "generation-1",
      selectedFileId: "readme",
      views: [active.registered],
    };
    expect(fileViewModeStillValid(active, valid)).toBe(true);
    expect(fileViewModeStillValid(active, { ...valid, selectedFileId: "other" })).toBe(false);
    expect(fileViewModeStillValid(active, { ...valid, activeViewKey: null })).toBe(false);
    expect(fileViewModeStillValid(active, { ...valid, reviewGeneration: "generation-2" })).toBe(
      false,
    );
    // An extension reload keeps the key but replaces the registration object.
    expect(
      fileViewModeStillValid(active, {
        ...valid,
        views: [createTestRegisteredFileView(active.mode)],
      }),
    ).toBe(false);
  });

  test("names the mode and its way out in the status hint", () => {
    expect(fileViewModeStatusHint(createTestActiveMode({ onKey: () => "handled" }))).toBe(
      "preview:rendered mode — Esc exits",
    );
  });

  test("runs lifecycle callbacks and contains throws and thenables as warnings", async () => {
    const warnings: string[] = [];
    const entered: string[] = [];
    const active = createTestActiveMode({
      onKey: () => "handled",
      onEnter: (ctx) => entered.push(ctx.file.id),
    });
    expect(runFileViewModeLifecycle(active, "onEnter", (message) => warnings.push(message))).toBe(
      true,
    );
    expect(entered).toEqual(["readme"]);
    // A mode with no callback for the phase is a silent success.
    expect(runFileViewModeLifecycle(active, "onExit", (message) => warnings.push(message))).toBe(
      true,
    );
    expect(warnings).toEqual([]);

    const broken = createTestActiveMode({
      onKey: () => "handled",
      onExit: () => {
        throw new Error("teardown exploded");
      },
    });
    expect(runFileViewModeLifecycle(broken, "onExit", (message) => warnings.push(message))).toBe(
      false,
    );
    const asyncEntry = createTestActiveMode({
      onEnter: (() => Promise.reject(new Error("late entry rejection"))) as never,
      onKey: () => "handled",
    });
    expect(
      runFileViewModeLifecycle(asyncEntry, "onEnter", (message) => warnings.push(message)),
    ).toBe(false);
    const asyncExit = createTestActiveMode({
      onExit: (() => Promise.reject(new Error("late exit rejection"))) as never,
      onKey: () => "handled",
    });
    expect(runFileViewModeLifecycle(asyncExit, "onExit", (message) => warnings.push(message))).toBe(
      false,
    );
    await Promise.resolve();

    expect(warnings).toEqual([
      'Extension preview file view "rendered" mode failed onExit • teardown exploded',
      'Extension preview file view "rendered" mode failed onEnter • onEnter must return synchronously',
      'Extension preview file view "rendered" mode failed onExit • onExit must return synchronously',
    ]);
  });

  test("normalizes key answers and turns throws and thenables into an exit", async () => {
    const warnings: string[] = [];
    const seen: string[] = [];
    const push = (message: string) => warnings.push(message);

    const handled = createTestActiveMode({
      onKey: (key) => {
        seen.push(key.name ?? "");
        return "handled";
      },
    });
    expect(deliverFileViewModeKey(handled, { name: "j" }, push)).toBe("handled");
    expect(seen).toEqual(["j"]);

    // Anything outside the documented answers declines, which is the reading
    // that leaves the app behaving as if no mode were running.
    const forgetful = createTestActiveMode({
      onKey: () => undefined as unknown as "pass",
    });
    expect(deliverFileViewModeKey(forgetful, { name: "j" }, push)).toBe("pass");
    expect(warnings).toEqual([]);

    const broken = createTestActiveMode({
      onKey: () => {
        throw new Error("key exploded");
      },
    });
    expect(deliverFileViewModeKey(broken, { name: "j" }, push)).toBe("exit");
    const asyncKey = createTestActiveMode({
      onKey: (() => Promise.reject(new Error("late key rejection"))) as never,
    });
    expect(deliverFileViewModeKey(asyncKey, { name: "j" }, push)).toBe("exit");
    await Promise.resolve();

    expect(warnings).toEqual([
      'Extension preview file view "rendered" mode failed onKey • key exploded',
      'Extension preview file view "rendered" mode failed onKey • onKey must return synchronously',
    ]);
  });
});

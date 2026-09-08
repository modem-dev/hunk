import { describe, expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useState } from "react";
import type { PersistedViewPreferences } from "../../core/run/config";
import {
  useViewPreferenceQuitController,
  type UseViewPreferenceQuitControllerOptions,
  type ViewPreferenceQuitScheduler,
} from "./useViewPreferenceQuitController";

/** Build a complete preference snapshot for controller tests. */
function createTestPreferences(
  overrides: Partial<PersistedViewPreferences> = {},
): PersistedViewPreferences {
  return {
    mode: "auto",
    theme: "github-dark-default",
    showLineNumbers: true,
    wrapLines: false,
    showHunkHeaders: true,
    showMenuBar: true,
    showAgentNotes: false,
    copyDecorations: false,
    cursorLine: "row",
    ...overrides,
  };
}

type HarnessInputs = Pick<
  UseViewPreferenceQuitControllerOptions,
  | "currentPreferences"
  | "configPath"
  | "pagerMode"
  | "promptSaveViewPreferences"
  | "transientViewPreferences"
  | "homeDirectory"
  | "quitScheduler"
>;

type TestScheduledQuit = {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
};

/** Capture delayed quits so tests can advance or cancel them without sleeping. */
function createTestQuitScheduler() {
  const scheduled: TestScheduledQuit[] = [];
  const schedule = mock((callback: () => void, delayMs: number) => {
    const quit = { callback, delayMs, cancelled: false };
    scheduled.push(quit);
    return quit;
  });
  const cancel = mock((handle: unknown) => {
    (handle as TestScheduledQuit).cancelled = true;
  });
  const scheduler: ViewPreferenceQuitScheduler = { schedule, cancel };

  return {
    scheduler,
    scheduled,
    schedule,
    cancel,
    run: (index = 0) => {
      const quit = scheduled[index];
      if (quit && !quit.cancelled) quit.callback();
    },
  };
}

/** Mount the controller with replaceable App-owned inputs and observable callbacks. */
async function renderController(overrides: Partial<HarnessInputs> = {}) {
  let controller!: ReturnType<typeof useViewPreferenceQuitController>;
  let setInputs!: (update: Partial<HarnessInputs>) => void;
  const onQuit = mock(() => undefined);
  const showNotice = mock((_message: string) => undefined);
  const showError = mock((_message: string) => undefined);
  const closeHelp = mock(() => undefined);
  const initialInputs: HarnessInputs = {
    currentPreferences: createTestPreferences(),
    configPath: undefined,
    pagerMode: false,
    promptSaveViewPreferences: true,
    transientViewPreferences: false,
    homeDirectory: "/test/home",
    ...overrides,
  };

  function Harness() {
    const [inputs, updateInputs] = useState(initialInputs);
    setInputs = (update) => updateInputs((current) => ({ ...current, ...update }));
    controller = useViewPreferenceQuitController({
      ...inputs,
      onQuit,
      showNotice,
      showError,
      closeHelp,
    });
    return null;
  }

  const setup = await testRender(<Harness />, { width: 40, height: 4 });
  await act(async () => setup.renderOnce());
  return {
    setup,
    controller: () => controller,
    update: async (update: Partial<HarnessInputs>) => {
      await act(async () => setInputs(update));
      await act(async () => setup.renderOnce());
    },
    onQuit,
    showNotice,
    showError,
    closeHelp,
  };
}

/** Destroy a mounted controller harness. */
async function destroyController(harness: Awaited<ReturnType<typeof renderController>>) {
  await act(async () => harness.setup.renderer.destroy());
}

describe("useViewPreferenceQuitController", () => {
  test("derives dirty preferences and aligned TOML rows in persistence order", async () => {
    const harness = await renderController();

    try {
      expect(harness.controller().changedViewPreferences).toEqual([]);

      await harness.update({
        currentPreferences: createTestPreferences({
          theme: "github-dark-dimmed",
          showLineNumbers: false,
          wrapLines: true,
        }),
      });

      expect(harness.controller().changedViewPreferences.map((change) => change.configKey)).toEqual(
        ["theme", "line_numbers", "wrap_lines"],
      );
      expect(harness.controller().viewPreferenceDiffLines).toEqual([
        { removed: true, text: '- theme        = "github-dark-default"' },
        { removed: false, text: '+ theme        = "github-dark-dimmed"' },
        { removed: true, text: "- line_numbers = true" },
        { removed: false, text: "+ line_numbers = false" },
        { removed: true, text: "- wrap_lines   = false" },
        { removed: false, text: "+ wrap_lines   = true" },
      ]);
      expect(harness.controller().changedViewPreferences).toHaveLength(3);
    } finally {
      await destroyController(harness);
    }
  });

  test("shortens config paths only when an explicit HOME contains them", async () => {
    const harness = await renderController({
      configPath: "/users/probe/.config/hunk/config.toml",
      homeDirectory: "/users/probe",
    });

    try {
      expect(harness.controller().viewPreferencesConfigLabel).toBe("~/.config/hunk/config.toml");

      await harness.update({ configPath: "/etc/hunk/config.toml" });
      expect(harness.controller().viewPreferencesConfigLabel).toBe("/etc/hunk/config.toml");

      await harness.update({
        configPath: "/users/probe/.config/hunk/config.toml",
        homeDirectory: undefined,
      });
      expect(harness.controller().viewPreferencesConfigLabel).toBe(
        "/users/probe/.config/hunk/config.toml",
      );

      await harness.update({ configPath: undefined });
      expect(harness.controller().viewPreferencesConfigLabel).toBe("~/.config/hunk/config.toml");
    } finally {
      await destroyController(harness);
    }
  });

  test("opens the prompt only for changed persistent preferences and closes help", async () => {
    const harness = await renderController();

    try {
      await harness.update({
        currentPreferences: createTestPreferences({ wrapLines: true }),
      });
      await act(async () => harness.controller().requestQuit());

      expect(harness.controller().saveConfigPromptOpen).toBe(true);
      expect(harness.closeHelp).toHaveBeenCalledTimes(1);
      expect(harness.onQuit).toHaveBeenCalledTimes(0);
    } finally {
      await destroyController(harness);
    }
  });

  test("bypasses prompting when unchanged, paging, transient, or disabled by policy", async () => {
    const cases: Array<{ label: string; inputs: Partial<HarnessInputs> }> = [
      { label: "unchanged", inputs: {} },
      { label: "pager", inputs: { pagerMode: true } },
      { label: "transient", inputs: { transientViewPreferences: true } },
      { label: "disabled", inputs: { promptSaveViewPreferences: false } },
    ];

    for (const { label, inputs } of cases) {
      const harness = await renderController(inputs);
      try {
        if (label !== "unchanged") {
          await harness.update({
            currentPreferences: createTestPreferences({ wrapLines: true }),
          });
        }
        await act(async () => harness.controller().requestQuit());

        expect(harness.controller().saveConfigPromptOpen, label).toBe(false);
        expect(harness.closeHelp, label).toHaveBeenCalledTimes(0);
        expect(harness.onQuit, label).toHaveBeenCalledTimes(1);
      } finally {
        await destroyController(harness);
      }
    }
  });

  test("saves preferences, closes the prompt, advances the baseline, and delays quit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hunk-view-controller-save-"));
    const configPath = join(directory, "config.toml");
    const quit = createTestQuitScheduler();
    const harness = await renderController({ configPath, quitScheduler: quit.scheduler });

    try {
      await harness.update({
        currentPreferences: createTestPreferences({ theme: "github-dark-dimmed" }),
      });
      await act(async () => harness.controller().requestQuit());
      expect(harness.controller().saveConfigPromptOpen).toBe(true);

      await act(async () => harness.controller().saveViewPreferencesAndQuit());
      await act(async () => harness.setup.renderOnce());

      expect(readFileSync(configPath, "utf8")).toContain('theme = "github-dark-dimmed"');
      expect(harness.controller().changedViewPreferences).toEqual([]);
      expect(harness.controller().saveConfigPromptOpen).toBe(false);
      expect(harness.showNotice).toHaveBeenCalledWith(`Saved view preferences to ${configPath}`);
      expect(harness.showError).toHaveBeenCalledTimes(0);
      expect(harness.onQuit).toHaveBeenCalledTimes(0);
      expect(quit.scheduled).toMatchObject([{ delayMs: 120, cancelled: false }]);

      quit.run();
      expect(harness.onQuit).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await destroyController(harness);
    }
  });

  test("locks persistence and quit actions after scheduling one successful quit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hunk-view-controller-duplicate-"));
    const configPath = join(directory, "config.toml");
    const quit = createTestQuitScheduler();
    const harness = await renderController({ configPath, quitScheduler: quit.scheduler });

    try {
      await harness.update({
        currentPreferences: createTestPreferences({ wrapLines: true }),
      });
      await act(async () => harness.controller().requestQuit());
      await act(async () => harness.controller().saveViewPreferencesAndQuit());

      await act(async () => {
        harness.controller().saveViewPreferencesAndQuit();
        harness.controller().neverAskToSaveViewPreferencesAndQuit();
        harness.controller().discardViewPreferencesAndQuit();
        harness.controller().requestQuit();
      });

      expect(quit.schedule).toHaveBeenCalledTimes(1);
      expect(quit.scheduled).toHaveLength(1);
      expect(harness.showNotice).toHaveBeenCalledTimes(1);
      expect(readFileSync(configPath, "utf8")).not.toContain(
        "prompt_save_view_preferences = false",
      );
      expect(harness.controller().saveConfigPromptOpen).toBe(false);
      expect(harness.onQuit).toHaveBeenCalledTimes(0);

      quit.run();
      expect(harness.onQuit).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await destroyController(harness);
    }
  });

  test("cancels a pending delayed quit when the controller unmounts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hunk-view-controller-unmount-"));
    const configPath = join(directory, "config.toml");
    const quit = createTestQuitScheduler();
    const harness = await renderController({ configPath, quitScheduler: quit.scheduler });
    let destroyed = false;

    try {
      await harness.update({
        currentPreferences: createTestPreferences({ wrapLines: true }),
      });
      await act(async () => harness.controller().saveViewPreferencesAndQuit());
      expect(quit.scheduled).toHaveLength(1);

      await destroyController(harness);
      destroyed = true;

      expect(quit.cancel).toHaveBeenCalledTimes(1);
      expect(quit.scheduled[0]?.cancelled).toBe(true);
      quit.run();
      expect(harness.onQuit).toHaveBeenCalledTimes(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      if (!destroyed) await destroyController(harness);
    }
  });

  test("reports save failures without advancing the baseline or quitting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hunk-view-controller-save-error-"));
    const harness = await renderController({ configPath: directory });

    try {
      await harness.update({
        currentPreferences: createTestPreferences({ wrapLines: true }),
      });
      await act(async () => harness.controller().requestQuit());
      await act(async () => harness.controller().saveViewPreferencesAndQuit());

      expect(harness.controller().changedViewPreferences).toHaveLength(1);
      expect(harness.controller().saveConfigPromptOpen).toBe(true);
      expect(harness.showNotice).toHaveBeenCalledTimes(0);
      expect(harness.showError).toHaveBeenCalledTimes(1);
      expect(harness.onQuit).toHaveBeenCalledTimes(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await destroyController(harness);
    }
  });

  test("discards without writing and quits immediately", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hunk-view-controller-discard-"));
    const configPath = join(directory, "config.toml");
    const harness = await renderController({ configPath });

    try {
      await harness.update({
        currentPreferences: createTestPreferences({ wrapLines: true }),
      });
      await act(async () => harness.controller().requestQuit());
      await act(async () => harness.controller().discardViewPreferencesAndQuit());

      expect(existsSync(configPath)).toBe(false);
      expect(harness.controller().saveConfigPromptOpen).toBe(false);
      expect(harness.onQuit).toHaveBeenCalledTimes(1);
      expect(harness.showNotice).toHaveBeenCalledTimes(0);
      expect(harness.showError).toHaveBeenCalledTimes(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await destroyController(harness);
    }
  });

  test("never-ask writes only prompt policy, closes the prompt, and delays quit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hunk-view-controller-never-"));
    const configPath = join(directory, "config.toml");
    writeFileSync(configPath, "# keep me\n");
    const quit = createTestQuitScheduler();
    const harness = await renderController({ configPath, quitScheduler: quit.scheduler });

    try {
      await harness.update({
        currentPreferences: createTestPreferences({ theme: "github-dark-dimmed" }),
      });
      await act(async () => harness.controller().requestQuit());
      expect(harness.controller().saveConfigPromptOpen).toBe(true);

      await act(async () => harness.controller().neverAskToSaveViewPreferencesAndQuit());

      const source = readFileSync(configPath, "utf8");
      expect(source).toContain("# keep me");
      expect(source).toContain("prompt_save_view_preferences = false");
      expect(source).not.toContain("theme =");
      expect(harness.controller().changedViewPreferences).toHaveLength(1);
      expect(harness.controller().saveConfigPromptOpen).toBe(false);
      expect(harness.showNotice).toHaveBeenCalledWith(
        `Won't ask to save view preferences again (${configPath})`,
      );
      expect(harness.showError).toHaveBeenCalledTimes(0);
      expect(harness.onQuit).toHaveBeenCalledTimes(0);
      expect(quit.scheduled).toMatchObject([{ delayMs: 120, cancelled: false }]);

      quit.run();
      expect(harness.onQuit).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await destroyController(harness);
    }
  });

  test("reports never-ask failures without quitting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hunk-view-controller-never-error-"));
    const harness = await renderController({ configPath: directory });

    try {
      await harness.update({
        currentPreferences: createTestPreferences({ wrapLines: true }),
      });
      await act(async () => harness.controller().requestQuit());
      await act(async () => harness.controller().neverAskToSaveViewPreferencesAndQuit());

      expect(harness.controller().changedViewPreferences).toHaveLength(1);
      expect(harness.controller().saveConfigPromptOpen).toBe(true);
      expect(harness.showNotice).toHaveBeenCalledTimes(0);
      expect(harness.showError).toHaveBeenCalledTimes(1);
      expect(harness.onQuit).toHaveBeenCalledTimes(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await destroyController(harness);
    }
  });

  test("cancels the prompt without quitting or clearing dirty state", async () => {
    const harness = await renderController();

    try {
      await harness.update({
        currentPreferences: createTestPreferences({ wrapLines: true }),
      });
      await act(async () => harness.controller().requestQuit());
      await act(async () => harness.controller().closeSaveConfigPrompt());

      expect(harness.controller().saveConfigPromptOpen).toBe(false);
      expect(harness.controller().changedViewPreferences).toHaveLength(1);
      expect(harness.onQuit).toHaveBeenCalledTimes(0);
    } finally {
      await destroyController(harness);
    }
  });

  test("preserves the mounted baseline when soft reload inputs change", async () => {
    const initial = createTestPreferences();
    const changed = createTestPreferences({ wrapLines: true });
    const harness = await renderController({
      currentPreferences: initial,
      configPath: "/review/one/config.toml",
    });

    try {
      await harness.update({ currentPreferences: changed });
      expect(harness.controller().changedViewPreferences).toMatchObject([
        { configKey: "wrap_lines", previousValue: "false", nextValue: "true" },
      ]);

      // AppHost replaces bootstrap on a soft reload, but the mounted App and its controller survive.
      await harness.update({
        currentPreferences: { ...changed },
        configPath: "/review/two/config.toml",
      });
      expect(harness.controller().viewPreferencesConfigLabel).toBe("/review/two/config.toml");
      expect(harness.controller().changedViewPreferences).toMatchObject([
        { configKey: "wrap_lines", previousValue: "false", nextValue: "true" },
      ]);

      await harness.update({ currentPreferences: { ...initial } });
      expect(harness.controller().changedViewPreferences).toEqual([]);
    } finally {
      await destroyController(harness);
    }
  });
});

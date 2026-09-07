import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import type { NamedCustomThemeConfig } from "../../extension-api/types";
import { availableThemes, TRANSPARENT_BACKGROUND } from "../themes";
import {
  useThemeSelectorController,
  type UseThemeSelectorControllerOptions,
} from "./useThemeSelectorController";

type ThemeSelectorController = ReturnType<typeof useThemeSelectorController>;

/** Mount the controller with replaceable bootstrap-like inputs. */
async function renderThemeSelectorController(initial: UseThemeSelectorControllerOptions) {
  let controller!: ThemeSelectorController;
  let replaceOptions!: (options: UseThemeSelectorControllerOptions) => void;

  function Probe() {
    const [options, setOptions] = useState(initial);
    replaceOptions = setOptions;
    controller = useThemeSelectorController(options);
    return null;
  }

  const setup = await testRender(<Probe />, { width: 80, height: 24 });
  await act(async () => {
    await setup.renderOnce();
  });

  return {
    get controller() {
      return controller;
    },
    replaceOptions,
    setup,
  };
}

/** Destroy a hook test renderer inside React's update boundary. */
async function destroyController(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    setup.renderer.destroy();
  });
}

/** Build a small custom theme suitable for identity and palette replacement tests. */
function customTheme(
  id: string,
  label: string,
  accent: string,
  base = "github-dark-default",
): NamedCustomThemeConfig {
  return { id, label, accent, base };
}

const noNotice = () => {};

describe("useThemeSelectorController", () => {
  test("resolves auto initialization from the detected light or dark terminal mode", async () => {
    const light = await renderThemeSelectorController({
      initialTheme: "auto",
      initialThemeMode: "light",
      onTransientNotice: noNotice,
      transparentBackground: false,
    });
    const dark = await renderThemeSelectorController({
      initialTheme: "auto",
      initialThemeMode: "dark",
      onTransientNotice: noNotice,
      transparentBackground: false,
    });

    try {
      expect(light.controller.themeId).toBe("github-light-default");
      expect(light.controller.baseTheme.appearance).toBe("light");
      expect(dark.controller.themeId).toBe("github-dark-default");
      expect(dark.controller.baseTheme.appearance).toBe("dark");
    } finally {
      await destroyController(light.setup);
      await destroyController(dark.setup);
    }
  });

  test("opens on the committed theme and wraps keyboard preview movement", async () => {
    const firstThemeId = availableThemes()[0]!.id;
    const harness = await renderThemeSelectorController({
      initialTheme: firstThemeId,
      onTransientNotice: noNotice,
      transparentBackground: false,
    });

    try {
      await act(async () => harness.controller.openThemeSelector());
      expect(harness.controller.themeSelectorOpen).toBe(true);
      expect(
        harness.controller.themeSelectorItems[harness.controller.themeSelectorSelectedIndex]?.id,
      ).toBe(firstThemeId);

      await act(async () => harness.controller.moveThemeSelector(-1));
      expect(harness.controller.themeSelectorSelectedIndex).toBe(
        harness.controller.themeSelectorItems.length - 1,
      );
      expect(harness.controller.themeId).toBe(firstThemeId);
      expect(harness.controller.baseTheme.id).toBe(
        harness.controller.themeSelectorItems.at(-1)!.id,
      );
      expect(harness.controller.themeSelectorItems[0]?.active).toBe(false);
      expect(harness.controller.themeSelectorItems.at(-1)?.active).toBe(true);

      await act(async () => harness.controller.moveThemeSelector(1));
      expect(harness.controller.themeSelectorSelectedIndex).toBe(0);
      expect(harness.controller.baseTheme.id).toBe(firstThemeId);
    } finally {
      await destroyController(harness.setup);
    }
  });

  test("pointer preview stays transient, cancel restores, and invalid item indexes are safe", async () => {
    const harness = await renderThemeSelectorController({
      initialTheme: "github-dark-default",
      onTransientNotice: noNotice,
      transparentBackground: false,
    });

    try {
      await act(async () => harness.controller.openThemeSelector());
      const previewIndex = 2;
      const previewId = harness.controller.themeSelectorItems[previewIndex]!.id;
      await act(async () => harness.controller.previewThemeSelectorItem(previewIndex));
      expect(harness.controller.baseTheme.id).toBe(previewId);
      expect(harness.controller.themeId).toBe("github-dark-default");
      expect(harness.controller.themeSelectorItems[previewIndex]?.active).toBe(true);

      await act(async () => {
        harness.controller.previewThemeSelectorItem(-1);
        harness.controller.acceptThemeSelectorItem(Number.MAX_SAFE_INTEGER);
      });
      expect(harness.controller.baseTheme.id).toBe(previewId);
      expect(harness.controller.themeSelectorOpen).toBe(true);

      await act(async () => harness.controller.closeThemeSelector());
      expect(harness.controller.themeSelectorOpen).toBe(false);
      expect(harness.controller.baseTheme.id).toBe("github-dark-default");
      expect(harness.controller.themeId).toBe("github-dark-default");
    } finally {
      await destroyController(harness.setup);
    }
  });

  test("pointer and keyboard acceptance commit atomically and preserve notices", async () => {
    const notices: string[] = [];
    const committed: string[] = [];
    const harness = await renderThemeSelectorController({
      initialTheme: "github-dark-default",
      onThemeCommitted: (themeId) => committed.push(themeId),
      onTransientNotice: (notice) => notices.push(notice),
      transparentBackground: false,
    });

    try {
      await act(async () => harness.controller.openThemeSelector());
      const pointerIndex = 2;
      const pointerItem = harness.controller.themeSelectorItems[pointerIndex]!;
      await act(async () => harness.controller.previewThemeSelectorItem(pointerIndex));
      await act(async () => harness.controller.acceptThemeSelectorItem(pointerIndex));
      expect(harness.controller.themeSelectorOpen).toBe(false);
      expect(harness.controller.themeId).toBe(pointerItem.id);
      expect(harness.controller.baseTheme.id).toBe(pointerItem.id);
      expect(notices).toEqual([`Theme: ${pointerItem.label}`]);

      await act(async () => harness.controller.openThemeSelector());
      await act(async () => harness.controller.moveThemeSelector(1));
      const keyboardItem =
        harness.controller.themeSelectorItems[harness.controller.themeSelectorSelectedIndex]!;
      await act(async () => harness.controller.acceptThemeSelector());
      expect(harness.controller.themeSelectorOpen).toBe(false);
      expect(harness.controller.themeId).toBe(keyboardItem.id);
      expect(harness.controller.baseTheme.id).toBe(keyboardItem.id);
      expect(notices.at(-1)).toBe(`Theme: ${keyboardItem.label}`);
      expect(committed).toEqual([pointerItem.id, keyboardItem.id]);
    } finally {
      await destroyController(harness.setup);
    }
  });

  test("accepts movement queued in the same React batch", async () => {
    const notices: string[] = [];
    const harness = await renderThemeSelectorController({
      initialTheme: "github-dark-default",
      onTransientNotice: (notice) => notices.push(notice),
      transparentBackground: false,
    });

    try {
      await act(async () => harness.controller.openThemeSelector());
      const initialIndex = harness.controller.themeSelectorSelectedIndex;
      const nextIndex = (initialIndex + 1) % harness.controller.themeSelectorItems.length;
      const nextItem = harness.controller.themeSelectorItems[nextIndex]!;

      await act(async () => {
        harness.controller.moveThemeSelector(1);
        harness.controller.acceptThemeSelector();
      });

      expect(harness.controller.themeSelectorOpen).toBe(false);
      expect(harness.controller.themeId).toBe(nextItem.id);
      expect(harness.controller.baseTheme.id).toBe(nextItem.id);
      expect(notices).toEqual([`Theme: ${nextItem.label}`]);
    } finally {
      await destroyController(harness.setup);
    }
  });

  test("transparent backgrounds only project the resolved base-theme surfaces", async () => {
    const custom = customTheme("team-dark", "Team Dark", "#8877cc");
    const harness = await renderThemeSelectorController({
      customThemes: [custom],
      initialTheme: custom.id,
      onTransientNotice: noNotice,
      transparentBackground: true,
    });

    try {
      expect(harness.controller.themeId).toBe(custom.id);
      expect(harness.controller.baseTheme.id).toBe(custom.id);
      expect(harness.controller.baseTheme.background).not.toBe(TRANSPARENT_BACKGROUND);
      expect(harness.controller.activeTheme.background).toBe(TRANSPARENT_BACKGROUND);
      expect(harness.controller.activeTheme.addedBg).toBe(harness.controller.baseTheme.addedBg);
    } finally {
      await destroyController(harness.setup);
    }
  });

  test("catalog replacement re-resolves palettes while preserving valid selected identities", async () => {
    const alpha = customTheme("alpha-theme", "Alpha", "#112233");
    const beta = customTheme("beta-theme", "Beta", "#445566");
    const harness = await renderThemeSelectorController({
      customThemes: [alpha, beta],
      initialTheme: alpha.id,
      onTransientNotice: noNotice,
      transparentBackground: false,
    });

    try {
      await act(async () => harness.controller.openThemeSelector());
      const betaIndex = harness.controller.themeSelectorItems.findIndex(
        (item) => item.id === beta.id,
      );
      await act(async () => harness.controller.previewThemeSelectorItem(betaIndex));

      const nextAlpha = customTheme(alpha.id, "Alpha updated", "#778899");
      const nextBeta = customTheme(beta.id, "Beta updated", "#aabbcc");
      await act(async () =>
        harness.replaceOptions({
          customThemes: [nextBeta, nextAlpha],
          initialTheme: "github-light-default",
          initialThemeMode: "light",
          onTransientNotice: noNotice,
          transparentBackground: false,
        }),
      );

      expect(harness.controller.themeId).toBe(alpha.id);
      expect(
        harness.controller.themeSelectorItems[harness.controller.themeSelectorSelectedIndex]?.id,
      ).toBe(beta.id);
      expect(harness.controller.baseTheme.id).toBe(beta.id);
      expect(harness.controller.baseTheme.accent).toBe("#aabbcc");

      await act(async () =>
        harness.replaceOptions({
          customThemes: [nextAlpha],
          initialTheme: "github-light-default",
          initialThemeMode: "light",
          onTransientNotice: noNotice,
          transparentBackground: false,
        }),
      );
      expect(harness.controller.themeId).toBe(alpha.id);
      expect(harness.controller.baseTheme.id).toBe(alpha.id);
      expect(harness.controller.themeSelectorSelectedIndex).toBeGreaterThanOrEqual(0);
      expect(harness.controller.themeSelectorSelectedIndex).toBeLessThan(
        harness.controller.themeSelectorItems.length,
      );

      await act(async () =>
        harness.replaceOptions({
          customThemes: [],
          initialTheme: "github-light-default",
          initialThemeMode: "light",
          onTransientNotice: noNotice,
          transparentBackground: false,
        }),
      );
      expect(harness.controller.themeId).toBe(alpha.id);
      expect(harness.controller.baseTheme.id).toBe("github-dark-default");
      expect(harness.controller.themeSelectorSelectedIndex).toBeGreaterThanOrEqual(0);
      expect(harness.controller.themeSelectorSelectedIndex).toBeLessThan(
        harness.controller.themeSelectorItems.length,
      );

      await act(async () =>
        harness.replaceOptions({
          customThemes: [nextAlpha],
          initialTheme: "github-light-default",
          initialThemeMode: "light",
          onTransientNotice: noNotice,
          transparentBackground: false,
        }),
      );
      expect(harness.controller.themeId).toBe(alpha.id);
      expect(harness.controller.baseTheme.id).toBe(alpha.id);
      expect(harness.controller.baseTheme.accent).toBe("#778899");
    } finally {
      await destroyController(harness.setup);
    }
  });

  test("soft bootstrap replacement preserves detected mode and the in-session choice", async () => {
    const harness = await renderThemeSelectorController({
      initialTheme: "auto",
      initialThemeMode: "dark",
      onTransientNotice: noNotice,
      transparentBackground: false,
    });

    try {
      await act(async () =>
        harness.replaceOptions({
          initialTheme: "auto",
          initialThemeMode: "light",
          onTransientNotice: noNotice,
          transparentBackground: false,
        }),
      );
      expect(harness.controller.themeId).toBe("github-dark-default");

      const draculaIndex = harness.controller.themeSelectorItems.findIndex(
        (item) => item.id === "dracula",
      );
      await act(async () => harness.controller.acceptThemeSelectorItem(draculaIndex));
      await act(async () =>
        harness.replaceOptions({
          initialTheme: "github-light-default",
          initialThemeMode: "light",
          onTransientNotice: noNotice,
          transparentBackground: false,
        }),
      );
      expect(harness.controller.themeId).toBe("dracula");
      expect(harness.controller.baseTheme.id).toBe("dracula");
    } finally {
      await destroyController(harness.setup);
    }
  });
});

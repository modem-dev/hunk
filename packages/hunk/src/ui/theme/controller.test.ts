import { afterEach, describe, expect, test } from "bun:test";
import {
  getDetectedTerminalColors,
  setDetectedTerminalColors,
} from "../../core/theme/terminalColors";
import { resolveTheme } from "../themes";
import { ThemeController } from "./controller";

describe("ThemeController", () => {
  afterEach(() => setDetectedTerminalColors(undefined));

  test("resolves launch state once and publishes committed identities", () => {
    const controller = new ThemeController({
      initialTheme: "auto",
      initialThemeMode: "light",
    });
    let publications = 0;
    const unsubscribe = controller.subscribe(() => {
      publications += 1;
    });

    expect(controller.initialThemeSelection).toBe("auto");
    expect(controller.getSnapshot().themeSelection).toBe("auto");
    expect(controller.themeId()).toBe("github-light-default");
    expect(controller.themeMode).toBe("light");

    controller.commitTheme("dracula");
    controller.commitTheme("dracula");
    expect(controller.getSnapshot().themeSelection).toBe("dracula");
    expect(controller.themeId()).toBe("dracula");
    expect(publications).toBe(1);

    unsubscribe();
    controller.commitTheme("github-dark-default");
    expect(publications).toBe(1);
  });

  test("publishes catalog replacements without changing the committed identity", () => {
    const initialThemes = [{ id: "team", accent: "#123456" }];
    const replacementThemes = [{ id: "team", accent: "#abcdef" }];
    const controller = new ThemeController({
      initialTheme: "team",
      customThemes: initialThemes,
    });
    let publications = 0;
    controller.subscribe(() => {
      publications += 1;
    });

    controller.replaceCustomThemes(replacementThemes);
    controller.replaceCustomThemes(replacementThemes);

    expect(controller.getSnapshot()).toMatchObject({
      themeSelection: "team",
      customThemes: replacementThemes,
    });
    expect(publications).toBe(1);
  });

  test("adopts switched terminal colors so the terminal theme repaints", () => {
    setDetectedTerminalColors({ foreground: "#c0caf5", background: "#1a1b26", palette: [] });
    const controller = new ThemeController({ initialTheme: "terminal", initialThemeMode: "dark" });
    let publications = 0;
    controller.subscribe(() => {
      publications += 1;
    });
    const before = resolveTheme("terminal", controller.themeMode ?? null);

    const lightColors = {
      foreground: "#4c4f69",
      background: "#eff1f5",
      palette: [undefined, "#d20f39", "#40a02b"],
    };
    controller.updateTerminalColors(lightColors);
    controller.updateTerminalColors(lightColors);

    expect(publications).toBe(1);
    expect(getDetectedTerminalColors()).toBe(lightColors);
    expect(controller.getSnapshot()).toMatchObject({
      themeSelection: "terminal",
      themeMode: "light",
      terminalColors: lightColors,
    });
    const after = resolveTheme("terminal", controller.themeMode ?? null);
    expect(after).not.toBe(before);
    expect(after).toMatchObject({ appearance: "light", background: "#eff1f5" });
    expect(after.removedSignColor).not.toBe(before.removedSignColor);
  });

  test("keeps an adaptive pair committed and names the side the terminal chose", () => {
    const pair = { dark: "vitesse-dark", light: "one-light" };
    const controller = new ThemeController({ initialTheme: pair, initialThemeMode: "light" });
    let publications = 0;
    controller.subscribe(() => {
      publications += 1;
    });

    expect(controller.getSnapshot().themeSelection).toEqual(pair);
    expect(controller.themeId()).toBe("one-light");

    controller.commitTheme({ ...pair });
    expect(publications).toBe(0);

    controller.commitTheme("dracula");
    expect(controller.getSnapshot().themeSelection).toBe("dracula");
    expect(publications).toBe(1);
  });

  test("switches an adaptive pair's side when the terminal changes background", () => {
    const pair = { dark: "vitesse-dark", light: "one-light" };
    const controller = new ThemeController({ initialTheme: pair, initialThemeMode: "dark" });
    expect(controller.themeId()).toBe("vitesse-dark");

    controller.updateTerminalColors({ foreground: "#4c4f69", background: "#eff1f5", palette: [] });

    expect(controller.getSnapshot().themeSelection).toEqual(pair);
    expect(controller.themeId()).toBe("one-light");
  });
});

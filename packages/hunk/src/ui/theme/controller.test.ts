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

    expect(controller.initialThemeId).toBe("github-light-default");
    expect(controller.getSnapshot().themeId).toBe("github-light-default");
    expect(controller.themeMode).toBe("light");

    controller.commitTheme("dracula");
    controller.commitTheme("dracula");
    expect(controller.getSnapshot().themeId).toBe("dracula");
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
      themeId: "team",
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
      themeId: "terminal",
      themeMode: "light",
      terminalColors: lightColors,
    });
    const after = resolveTheme("terminal", controller.themeMode ?? null);
    expect(after).not.toBe(before);
    expect(after).toMatchObject({ appearance: "light", background: "#eff1f5" });
    expect(after.removedSignColor).not.toBe(before.removedSignColor);
  });
});

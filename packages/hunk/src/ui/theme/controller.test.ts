import { describe, expect, test } from "bun:test";
import { ThemeController } from "./controller";

describe("ThemeController", () => {
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

    expect(controller.getSnapshot()).toEqual({
      themeId: "team",
      customThemes: replacementThemes,
    });
    expect(publications).toBe(1);
  });
});

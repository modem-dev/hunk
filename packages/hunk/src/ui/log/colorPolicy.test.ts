import { describe, expect, test } from "bun:test";
import { resolveTheme } from "../themes";
import { interactiveLogUsesColor, monochromeLogTheme } from "./colorPolicy";

describe("interactive log color policy", () => {
  test("honors explicit color precedence and terminal conventions", () => {
    expect(interactiveLogUsesColor("always", { NO_COLOR: "", TERM: "dumb" })).toBe(true);
    expect(interactiveLogUsesColor("never", {})).toBe(false);
    expect(interactiveLogUsesColor("auto", { NO_COLOR: "" })).toBe(false);
    expect(interactiveLogUsesColor("auto", { TERM: "dumb" })).toBe(false);
    expect(interactiveLogUsesColor("auto", { TERM: "xterm-256color" })).toBe(true);
  });

  test("does not expose selected theme colors when color is disabled", () => {
    const selected = resolveTheme("github-dark-default", null);
    const neutral = monochromeLogTheme(selected, "dark");
    expect(neutral.id).toBe("terminal-monochrome");
    expect(neutral.accent).toBe("#ffffff");
    expect(neutral.background).toBe("#000000");
    expect(neutral.accent).not.toBe(selected.accent);
  });
});

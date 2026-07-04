import { describe, expect, test } from "bun:test";
import { resolveTheme } from "../../themes";
import { renderStmlToAnsi, renderStmlToText } from "./render";

describe("renderStmlToText", () => {
  test("renders markup to plain rows without trailing whitespace", () => {
    const { lines, errors } = renderStmlToText("<box border>hi</box>", 12);
    expect(errors).toEqual([]);
    expect(lines).toEqual([`┌${"─".repeat(10)}┐`, "│hi        │", `└${"─".repeat(10)}┘`]);
  });

  test("surfaces render notes for degraded markup", () => {
    const { errors } = renderStmlToText("<wat>x</wat>", 40);
    expect(errors.some((error) => error.includes("unknown tag"))).toBe(true);
  });
});

describe("renderStmlToAnsi", () => {
  const theme = resolveTheme("github-dark-default", null);

  test("emits truecolor SGR sequences for styled spans", () => {
    const { lines } = renderStmlToAnsi('<c fg="success">ok</c>', 20, theme);
    expect(lines[0]).toMatch(/\x1b\[38;2;\d+;\d+;\d+mok\x1b\[0m/);
  });

  test("emits attribute codes for bold text", () => {
    const { lines } = renderStmlToAnsi("<b>bold</b>", 20, theme);
    expect(lines[0]).toContain("\x1b[1m");
  });

  test("leaves plain spans free of escape codes", () => {
    const { lines } = renderStmlToAnsi("plain", 20, theme);
    expect(lines[0]).toBe("plain");
  });
});

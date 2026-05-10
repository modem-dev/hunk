import { describe, expect, test } from "bun:test";
import { parseBinding, parseKeyToken } from "./parse";

describe("parseKeyToken", () => {
  test("parses bare printable as sequence", () => {
    const spec = parseKeyToken("q");
    expect(spec).toEqual({
      sequence: "q",
      ctrl: false,
      shift: false,
      meta: false,
      alt: false,
    });
  });

  test("parses bracketed special key", () => {
    const spec = parseKeyToken("<esc>");
    expect(spec).toEqual({
      name: "escape",
      ctrl: false,
      shift: false,
      meta: false,
      alt: false,
    });
  });

  test("parses ctrl modifier", () => {
    const spec = parseKeyToken("<c-c>");
    expect(spec).toMatchObject({ name: "c", ctrl: true });
  });

  test("parses shift+arrow", () => {
    const spec = parseKeyToken("<s-up>");
    expect(spec).toMatchObject({ name: "up", shift: true });
  });

  test("parses stacked modifiers", () => {
    const spec = parseKeyToken("<c-s-a>");
    expect(spec).toMatchObject({ name: "a", ctrl: true, shift: true });
  });

  test("parses function key", () => {
    expect(parseKeyToken("<f10>")).toMatchObject({ name: "f10" });
    expect(parseKeyToken("<f1>")).toMatchObject({ name: "f1" });
  });

  test("returns disabled sentinel", () => {
    expect(parseKeyToken("<disabled>")).toBe("disabled");
  });

  test("rejects malformed tokens", () => {
    expect(parseKeyToken("")).toBeNull();
    expect(parseKeyToken("<>")).toBeNull();
    expect(parseKeyToken("<unclosed")).toBeNull();
    expect(parseKeyToken("multi")).toBeNull();
    expect(parseKeyToken("<f13>")).toBeNull();
    expect(parseKeyToken("<x-foo>")).toBeNull();
  });

  test("treats <return> alias as enter", () => {
    expect(parseKeyToken("<return>")).toMatchObject({ name: "enter" });
    expect(parseKeyToken("<enter>")).toMatchObject({ name: "enter" });
  });
});

describe("parseBinding", () => {
  test("accepts string form", () => {
    const result = parseBinding("q");
    expect(result.disabled).toBe(false);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0]?.sequence).toBe("q");
  });

  test("accepts array form", () => {
    const result = parseBinding(["q", "<c-c>"]);
    expect(result.specs).toHaveLength(2);
  });

  test("disabled wins over other tokens", () => {
    const result = parseBinding(["q", "<disabled>"]);
    expect(result.disabled).toBe(true);
    expect(result.specs).toEqual([]);
    expect(result.mixedWithDisabled).toBe(true);
  });

  test("plain <disabled> is not flagged as mixed", () => {
    const single = parseBinding("<disabled>");
    expect(single.disabled).toBe(true);
    expect(single.mixedWithDisabled).toBe(false);

    const arr = parseBinding(["<disabled>"]);
    expect(arr.disabled).toBe(true);
    expect(arr.mixedWithDisabled).toBe(false);
  });

  test("disabled mixed with a rejected token is also flagged", () => {
    const result = parseBinding(["<disabled>", "<bogus>"]);
    expect(result.disabled).toBe(true);
    expect(result.mixedWithDisabled).toBe(true);
    expect(result.rejectedTokens).toEqual(["<bogus>"]);
  });

  test("reports unparseable tokens via rejectedTokens", () => {
    const result = parseBinding(["q", "<bogus>"]);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0]?.sequence).toBe("q");
    expect(result.rejectedTokens).toEqual(["<bogus>"]);
    expect(result.mixedWithDisabled).toBe(false);
  });
});

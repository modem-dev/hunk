import { describe, expect, test } from "bun:test";
import { formatBinding, formatKeySpec } from "./format";
import { parseKeyToken } from "./parse";

function spec(token: string) {
  const parsed = parseKeyToken(token);
  if (!parsed || parsed === "disabled") {
    throw new Error(`bad fixture token: ${token}`);
  }
  return parsed;
}

describe("formatKeySpec", () => {
  test("renders bare characters verbatim", () => {
    expect(formatKeySpec(spec("q"))).toBe("q");
    expect(formatKeySpec(spec("?"))).toBe("?");
    expect(formatKeySpec(spec("["))).toBe("[");
  });

  test("renders named keys with friendly labels", () => {
    expect(formatKeySpec(spec("<esc>"))).toBe("Esc");
    expect(formatKeySpec(spec("<f10>"))).toBe("F10");
    expect(formatKeySpec(spec("<space>"))).toBe("Space");
  });

  test("renders modifiers with + separator", () => {
    expect(formatKeySpec(spec("<c-c>"))).toBe("Ctrl+C");
    expect(formatKeySpec(spec("<s-space>"))).toBe("Shift+Space");
    expect(formatKeySpec(spec("<c-s-a>"))).toBe("Ctrl+Shift+A");
  });
});

describe("formatBinding", () => {
  test("joins multiple specs with slashes", () => {
    expect(formatBinding([spec("q"), spec("<esc>")])).toBe("q / Esc");
  });

  test("renders empty list as disabled", () => {
    expect(formatBinding([])).toBe("disabled");
  });
});

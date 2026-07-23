import { describe, expect, test } from "bun:test";
import { getFiletypeFromFileName } from "./fileLanguage";

describe("custom file language registration", () => {
  test("maps TypeScript module/commonjs extensions to typescript", () => {
    expect(getFiletypeFromFileName("foo.mts")).toBe("typescript");
    expect(getFiletypeFromFileName("foo.cts")).toBe("typescript");
    expect(getFiletypeFromFileName("src/nested/foo.mts")).toBe("typescript");
  });

  test("maps Odin source files to odin", () => {
    expect(getFiletypeFromFileName("main.odin")).toBe("odin");
    expect(getFiletypeFromFileName("src/nested/main.odin")).toBe("odin");
  });

  test("preserves Pierre's built-in extension detection", () => {
    expect(getFiletypeFromFileName("foo.ts")).toBe("typescript");
    expect(getFiletypeFromFileName("foo.tsx")).toBe("tsx");
    expect(getFiletypeFromFileName("foo.mjs")).toBe("javascript");
    expect(getFiletypeFromFileName("foo.cjs")).toBe("javascript");
  });
});

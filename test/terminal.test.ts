import { describe, expect, test } from "bun:test";
import type { CliInput } from "../src/core/types";
import { resolveRuntimeCliInput, shouldUsePagerMode, usesPipedPatchInput } from "../src/core/terminal";

function createPatchInput(file?: string, pager = false): CliInput {
  return {
    kind: "patch",
    file,
    options: {
      mode: "auto",
      pager,
    },
  };
}

describe("terminal runtime defaults", () => {
  test("treats stdin patch mode as pager-style when stdin is piped", () => {
    const input = createPatchInput("-", false);

    expect(usesPipedPatchInput(input, false)).toBe(true);
    expect(shouldUsePagerMode(input, false)).toBe(true);
    expect(resolveRuntimeCliInput(input, false).options.pager).toBe(true);
  });

  test("does not force pager mode for patch files or interactive stdin", () => {
    expect(usesPipedPatchInput(createPatchInput("changes.patch"), false)).toBe(false);
    expect(shouldUsePagerMode(createPatchInput("changes.patch"), false)).toBe(false);
    expect(shouldUsePagerMode(createPatchInput("-"), true)).toBe(false);
  });

  test("keeps explicit pager mode enabled", () => {
    const input = createPatchInput(undefined, true);

    expect(shouldUsePagerMode(input, true)).toBe(true);
    expect(resolveRuntimeCliInput(input, true).options.pager).toBe(true);
  });
});

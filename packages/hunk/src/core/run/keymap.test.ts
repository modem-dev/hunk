import { describe, expect, test } from "bun:test";
import { HUNK_VENDOR_EXTENSION_ID } from "../../extensions/extensionIds";
import { HUNK_COMMAND_OWNER } from "./keymap";

describe("keymap command owner", () => {
  test("names the same vendor namespace the extension host reserves", () => {
    expect(HUNK_COMMAND_OWNER).toBe(HUNK_VENDOR_EXTENSION_ID);
  });
});

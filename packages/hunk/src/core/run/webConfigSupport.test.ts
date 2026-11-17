import { describe, expect, test } from "bun:test";
import { CONFIG_REFERENCE_OPTIONS } from "./config";
import { WEB_CONFIG_SUPPORT } from "./webConfigSupport";

describe("WEB_CONFIG_SUPPORT", () => {
  test("classifies exactly the options in the config reference", () => {
    expect(Object.keys(WEB_CONFIG_SUPPORT).sort()).toEqual(
      CONFIG_REFERENCE_OPTIONS.map((option) => option.key).sort(),
    );
  });

  test("gives every option the page does not apply a one-sentence reason", () => {
    for (const [key, support] of Object.entries(WEB_CONFIG_SUPPORT)) {
      if (support.kind === "published" && support.applied) continue;
      const reason = "reason" in support ? support.reason : "";
      expect([key, /^[A-Z][^\n]*\.$/.test(reason)]).toEqual([key, true]);
      expect([key, reason.split(/\.\s/).length]).toEqual([key, 1]);
    }
  });

  test("lands each published option in its own presentation field", () => {
    const fields = Object.values(WEB_CONFIG_SUPPORT).flatMap((support) =>
      support.kind === "published" ? [support.field] : [],
    );
    expect(new Set(fields).size).toBe(fields.length);
  });
});

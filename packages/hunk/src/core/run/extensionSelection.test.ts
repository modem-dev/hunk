import { describe, expect, test } from "bun:test";
import { normalizeExtensionSelectionIds, resolveExtensionSelection } from "./extensionSelection";

describe("extension selection", () => {
  test("unions config disables while preserving user attribution", () => {
    expect(
      resolveExtensionSelection({
        id: "acme",
        kind: "user",
        userDisabled: ["acme"],
        repoDisabled: ["acme"],
      }),
    ).toEqual({ id: "acme", enabled: false, source: "user-config" });
  });

  test("uses the last CLI operation and permits an explicit enable", () => {
    expect(
      resolveExtensionSelection({
        id: "hunk.gh",
        kind: "bundled",
        userDisabled: ["hunk.gh"],
        cliOverrides: [
          { id: "hunk.gh", enabled: false },
          { id: "hunk.gh", enabled: true },
        ],
      }),
    ).toEqual({ id: "hunk.gh", enabled: true, source: "cli" });
  });

  test("keeps the master switch scoped to user extensions", () => {
    expect(
      resolveExtensionSelection({ id: "tool", kind: "user", userExtensionsEnabled: false }),
    ).toEqual({ id: "tool", enabled: false, source: "master-switch" });
    expect(
      resolveExtensionSelection({ id: "hunk.gh", kind: "bundled", userExtensionsEnabled: false }),
    ).toEqual({ id: "hunk.gh", enabled: true, source: "default" });
  });

  test("normalizes, deduplicates, and drops empty identities", () => {
    expect(normalizeExtensionSelectionIds([" hunk.gh ", "", "  ", "hunk.gh", "tool"])).toEqual([
      "hunk.gh",
      "tool",
    ]);
  });
});

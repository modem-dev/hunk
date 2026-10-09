import { describe, expect, test } from "bun:test";
import { THEMES } from "../../themes";
import { documentWorkerEligibility } from "./documentWorkerEligibility";

const theme = THEMES.find((candidate) => candidate.id === "github-dark-default")!;
const lines = (count: number) =>
  Array.from({ length: count }, () => "const answer = 42;").join("\n");
const base = {
  language: "typescript",
  path: "example.ts",
  text: lines(40),
  theme,
};

describe("document worker eligibility", () => {
  test("returns exact worker inputs for bounded bundled-theme documents", () => {
    expect(
      documentWorkerEligibility({
        ...base,
        runtime: { platform: "linux", execPath: "/opt/hunk/bin/hunk" },
      }),
    ).toEqual({
      eligible: true,
      input: {
        appearance: "dark",
        language: "typescript",
        path: "example.ts",
        text: lines(40),
        theme: "github-dark-default",
      },
    });
  });

  test("offloads documents of any size so no grammar compiles on the main thread", () => {
    expect(
      documentWorkerEligibility({
        ...base,
        text: lines(1),
        runtime: { platform: "linux", execPath: "/opt/hunk/bin/hunk" },
      }),
    ).toMatchObject({ eligible: true });
  });

  test("keeps custom syntax scope themes inline", () => {
    expect(
      documentWorkerEligibility({
        ...base,
        theme: { ...theme, syntaxScopeOverrides: { keyword: "#112233" } },
        runtime: { platform: "linux", execPath: "/opt/hunk/bin/hunk" },
      }),
    ).toMatchObject({ eligible: false, reason: "custom-theme" });
  });

  test("rejects unsupported runtimes and invalid document bounds", () => {
    expect(
      documentWorkerEligibility({
        ...base,
        runtime: {
          platform: "win32",
          execPath: "C:\\Program Files\\Hunk\\hunk.exe",
        },
      }),
    ).toMatchObject({ eligible: false, reason: "runtime-unavailable" });
    expect(
      documentWorkerEligibility({
        ...base,
        text: "x".repeat(1_000),
        runtime: { platform: "linux", execPath: "/opt/hunk/bin/hunk" },
      }),
    ).toMatchObject({ eligible: false, reason: "invalid-document" });
  });
});

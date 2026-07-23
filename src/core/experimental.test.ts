import { describe, expect, test } from "bun:test";
import { createTestAgentFileContext, createTestDiffFile } from "../../test/helpers/diff-helpers";
import { resolveExperimentalDiffFiles, resolveExperimentalFeatures } from "./experimental";

describe("experimental review features", () => {
  test("normal reviews derive plain-text note fallbacks without mutating sidecar data", () => {
    const agent = createTestAgentFileContext("example.ts", {
      annotations: [
        {
          newRange: [1, 1],
          summary: "Updated the answer.",
          markup: "<badge>42</badge>",
        },
      ],
    });
    const files = [createTestDiffFile({ agent })];

    const resolved = resolveExperimentalDiffFiles(files, {});

    expect(resolved[0]?.agent?.annotations[0]?.summary).toBe("Updated the answer.");
    expect(resolved[0]?.agent?.annotations[0]?.markup).toBeUndefined();
    expect(files[0]?.agent?.annotations[0]?.markup).toBe("<badge>42</badge>");
  });

  test("experimental reviews preserve STML and advertise the feature", () => {
    const files = [
      createTestDiffFile({
        agent: createTestAgentFileContext("example.ts", {
          annotations: [{ summary: "Updated", markup: "<badge>42</badge>" }],
        }),
      }),
    ];

    expect(resolveExperimentalDiffFiles(files, { experimental: true })).toBe(files);
    expect(resolveExperimentalFeatures({ experimental: true })).toEqual(["stml"]);
    expect(resolveExperimentalFeatures({})).toEqual([]);
  });
});

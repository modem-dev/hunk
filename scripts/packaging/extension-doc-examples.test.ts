import { describe, expect, test } from "bun:test";
import { buildDocExamples, extractTypeScriptBlocks } from "./extension-doc-examples";

describe("extractTypeScriptBlocks", () => {
  test("returns every ts-fenced block in document order", () => {
    const blocks = extractTypeScriptBlocks(
      [
        "prose",
        "```ts",
        "const first = 1;",
        "```",
        "more",
        "```ts",
        "const second = 2;",
        "```",
        "",
      ].join("\n"),
    );

    expect(blocks).toEqual(["const first = 1;\n", "const second = 2;\n"]);
  });

  test("ignores fences for other languages", () => {
    const blocks = extractTypeScriptBlocks(
      ["```toml", 'vcs = "git"', "```", "```bash", "hunk diff", "```", ""].join("\n"),
    );

    expect(blocks).toEqual([]);
  });

  test("skips empty blocks", () => {
    expect(extractTypeScriptBlocks(["```ts", "", "```", ""].join("\n"))).toEqual([]);
  });
});

describe("buildDocExamples", () => {
  /** Build one example from a single fenced block. */
  function buildOne(body: string) {
    const examples = buildDocExamples(["```ts", body, "```", ""].join("\n"));
    expect(examples).toHaveLength(1);
    return examples[0]!;
  }

  test("treats an importing block as a whole module and adds no imports of its own", () => {
    const example = buildOne('import type { HunkExtensionAPI } from "hunkdiff/extension";');

    expect(example.wrapper).toBe("module");
    // The preamble's own imports are aliased, so they cannot collide with the
    // example's — that collision is what made the first harness run fail.
    expect(example.text).toContain("as __HunkApi");
    expect(example.text).toContain('import type { HunkExtensionAPI } from "hunkdiff/extension";');
  });

  test("wraps a bare API call in a factory body", () => {
    const example = buildOne('hunk.registerFileLanguage(".zig", "zig");');

    expect(example.wrapper).toBe("factory-body");
    expect(example.text).toContain("export function __example()");
  });

  test("wraps an operation member in a typed operation literal", () => {
    const example = buildOne(
      'watchPlan: (input, ctx) => ({ coverage: "poll-only", targets: [] }),',
    );

    expect(example.wrapper).toBe("vcs-operation");
    expect(example.text).toContain("__HunkOperation<__HunkDiffInput>");
  });

  test("wraps an extraFiles fragment in a patch-result literal, without its statement semicolon", () => {
    const example = buildOne("extraFiles: [];");

    expect(example.wrapper).toBe("patch-result");
    expect(example.text).toContain("__HunkPatchResult");
    expect(example.text).not.toContain("extraFiles: [];");
  });

  test("names examples by position so a failure points at the right block", () => {
    const examples = buildDocExamples(
      ["```ts", "const a = 1;", "```", "```ts", "const b = 2;", "```", ""].join("\n"),
    );

    expect(examples.map((example) => example.name)).toEqual([
      "doc-example-01.ts",
      "doc-example-02.ts",
    ]);
  });
});

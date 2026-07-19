import { describe, expect, test } from "bun:test";
import { legacySyntaxColorsToScopes, resolveSyntaxScopeOverrides } from "./legacySyntaxScopes";

describe("legacy syntax scope compatibility", () => {
  test("translates every deprecated semantic role into raw TextMate selectors", () => {
    expect(
      legacySyntaxColorsToScopes({
        default: "#000001",
        keyword: "#000002",
        string: "#000003",
        comment: "#000004",
        number: "#000005",
        function: "#000006",
        property: "#000007",
        type: "#000008",
        variable: "#000009",
        operator: "#00000a",
        punctuation: "#00000b",
      }),
    ).toEqual({
      source: "#000001",
      keyword: "#000002",
      string: "#000003",
      comment: "#000004",
      "punctuation.definition.comment": "#000004",
      "constant.numeric": "#000005",
      "entity.name.function": "#000006",
      "support.function": "#000006",
      "variable.function": "#000006",
      "variable.other.property": "#000007",
      "support.variable.property": "#000007",
      "entity.name.type": "#000008",
      "entity.name.class": "#000008",
      "support.type": "#000008",
      "support.class": "#000008",
      variable: "#000009",
      "keyword.operator": "#00000a",
      punctuation: "#00000b",
    });
  });

  test("lets exact scope configuration override translated compatibility rules", () => {
    expect(
      resolveSyntaxScopeOverrides(
        { comment: "#111111" },
        { comment: "#222222", "comment.block": "#333333" },
      ),
    ).toEqual({
      comment: "#222222",
      "punctuation.definition.comment": "#111111",
      "comment.block": "#333333",
    });
  });
});

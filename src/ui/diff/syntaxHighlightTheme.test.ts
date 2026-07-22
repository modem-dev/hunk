import { describe, expect, test } from "bun:test";
import { resolveTheme } from "../themes";
import { syntaxHighlightThemeName } from "./syntaxHighlightTheme";

describe("syntaxHighlightThemeName", () => {
  test("includes precedence-sensitive TextMate rule order in the theme identity", () => {
    const broadRuleFirst = resolveTheme("custom", null, {
      base: "github-dark-default",
      syntaxScopes: {
        comment: "#111111",
        "comment, string": "#222222",
      },
    });
    const broadRuleLast = resolveTheme("custom", null, {
      base: "github-dark-default",
      syntaxScopes: {
        "comment, string": "#222222",
        comment: "#111111",
      },
    });

    expect(syntaxHighlightThemeName(broadRuleFirst)).not.toBe(
      syntaxHighlightThemeName(broadRuleLast),
    );
  });
});

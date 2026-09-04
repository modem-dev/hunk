import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { bundledLanguages } from "shiki";
import { renderBundledSyntaxLanguages } from "../../../scripts/generate-bundled-syntax-languages";
import { BUNDLED_SYNTAX_LANGUAGE_IDS } from "./bundledSyntaxLanguages.generated";
import {
  replaceExtensionSyntaxGrammars,
  restoreSyntaxGrammars,
  syntaxGrammarSnapshot,
} from "./syntaxGrammar";

describe("syntax grammar registry", () => {
  test("keeps the generated bundled-id collision list current and formatter-stable", () => {
    expect([...BUNDLED_SYNTAX_LANGUAGE_IDS].sort()).toEqual(Object.keys(bundledLanguages).sort());
    expect(
      readFileSync(resolve(import.meta.dir, "bundledSyntaxLanguages.generated.ts"), "utf8"),
    ).toBe(renderBundledSyntaxLanguages());
  });

  test("changes digest only when normalized grammar bytes change", () => {
    replaceExtensionSyntaxGrammars([]);
    const empty = syntaxGrammarSnapshot();
    const registration = {
      extensionId: "demo",
      grammar: Object.freeze({
        id: "demo",
        scopeName: "source.demo",
        patterns: Object.freeze([{ match: "demo", name: "keyword.demo" }]),
      }),
    };
    const first = replaceExtensionSyntaxGrammars([registration]);
    const same = replaceExtensionSyntaxGrammars([registration]);
    expect(same).toBe(first);
    expect(first.digest).not.toBe(empty.digest);

    restoreSyntaxGrammars(empty);
    expect(syntaxGrammarSnapshot().digest).toBe(empty.digest);
    expect(syntaxGrammarSnapshot().generation).toBeGreaterThan(first.generation);
  });
});

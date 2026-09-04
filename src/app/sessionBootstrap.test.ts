import { describe, expect, test } from "bun:test";
import { fileLanguageForPath } from "../core/changeset/fileLanguageLookup";
import { replaceExtensionFileLanguages } from "../core/changeset/fileLanguage";
import {
  replaceExtensionSyntaxGrammars,
  syntaxGrammarSnapshot,
} from "../core/changeset/syntaxGrammar";
import type { HunkConfigResolution } from "../core/run/config";
import type { AppBootstrap } from "../core/bootstrap";
import type { CliInput } from "../core/run/commandInputs";
import { createEmptyExtensionLoadResult } from "../extensions/types";
import { loadConfiguredSessionBootstrap } from "./sessionBootstrap";

/** Build the minimal normalized input needed by application-bootstrap tests. */
function createTestInput(): CliInput {
  return { kind: "vcs", staged: false, options: { vcs: "git" } };
}

/** Build a configuration result without reading user or repository config files. */
function createTestConfig(input: CliInput): HunkConfigResolution {
  return {
    input,
    customThemes: [],
    extensions: { enabled: false, paths: [], repoPaths: [], extensionConfigs: {} },
    keybindings: { "hunk.review.nextHunk": "]" },
    viewPreferencesConfigPath: "/tmp/hunk-config.toml",
  };
}

/** Build a loader result with a stable changeset for transform assertions. */
function createTestBootstrap(input: CliInput): AppBootstrap {
  return {
    input,
    reloadContext: { cwd: process.cwd() },
    changeset: { id: "changeset:test", sourceLabel: "test", title: "before", files: [] },
    initialMode: "auto",
  };
}

describe("loadConfiguredSessionBootstrap", () => {
  test("shares extension-aware loading and session fields across launch and reload callers", async () => {
    const input = createTestInput();
    const extensions = createEmptyExtensionLoadResult();
    extensions.registry.changesetTransforms.push({
      extensionId: "test-extension",
      transform: (changeset) => ({ ...changeset, title: "after" }),
    });

    const result = await loadConfiguredSessionBootstrap({
      configured: createTestConfig(input),
      cwd: process.cwd(),
      extensions,
      initialThemeMode: "dark",
      loadAppBootstrapImpl: async (resolvedInput) => createTestBootstrap(resolvedInput),
    });

    expect(result.input).toEqual(input);
    expect(result.bootstrap.changeset.title).toBe("after");
    expect(result.bootstrap.extensions).toBe(extensions);
    expect(result.bootstrap.initialThemeMode).toBe("dark");
    expect(result.bootstrap.keybindings).toEqual({ "hunk.review.nextHunk": "]" });
    expect(result.bootstrap.viewPreferencesConfigPath).toBe("/tmp/hunk-config.toml");
  });

  test("restores file-language and syntax-grammar generations when bootstrap loading fails", async () => {
    replaceExtensionFileLanguages([
      {
        matcher: { kind: "filename", value: "CurrentHunkfile" },
        language: "python",
      },
    ]);
    replaceExtensionSyntaxGrammars([
      {
        extensionId: "current",
        grammar: Object.freeze({
          id: "current",
          scopeName: "source.current",
          patterns: Object.freeze([{ match: "current" }]),
        }),
      },
    ]);
    const input = createTestInput();
    const extensions = createEmptyExtensionLoadResult();
    extensions.registry.syntaxGrammars.push({
      extensionId: "replacement",
      grammar: Object.freeze({
        id: "replacement",
        scopeName: "source.replacement",
        patterns: Object.freeze([{ match: "replacement" }]),
      }),
    });
    extensions.registry.fileLanguages.push({
      extensionId: "replacement",
      matcher: { kind: "filename", value: "ReplacementHunkfile" },
      language: "ruby",
    });

    await expect(
      loadConfiguredSessionBootstrap({
        configured: createTestConfig(input),
        cwd: process.cwd(),
        extensions,
        loadAppBootstrapImpl: async () => {
          expect(fileLanguageForPath("ReplacementHunkfile")).toBe("ruby");
          expect(syntaxGrammarSnapshot().grammars.map(({ id }) => id)).toEqual(["replacement"]);
          throw new Error("load failed");
        },
      }),
    ).rejects.toThrow("load failed");

    expect(fileLanguageForPath("CurrentHunkfile")).toBe("python");
    expect(fileLanguageForPath("ReplacementHunkfile")).toBe("text");
    expect(syntaxGrammarSnapshot().grammars.map(({ id }) => id)).toEqual(["current"]);
    replaceExtensionFileLanguages([]);
    replaceExtensionSyntaxGrammars([]);
  });
});

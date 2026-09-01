import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileLanguageForPath } from "../core/changeset/fileLanguageLookup";
import { replaceExtensionFileLanguages } from "../core/changeset/fileLanguage";
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

  test("restores the active file-language selectors when bootstrap loading fails", async () => {
    replaceExtensionFileLanguages([
      {
        matcher: { kind: "filename", value: "CurrentHunkfile" },
        language: "python",
      },
    ]);
    const input = createTestInput();
    const extensions = createEmptyExtensionLoadResult();
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
          throw new Error("load failed");
        },
      }),
    ).rejects.toThrow("load failed");

    expect(fileLanguageForPath("CurrentHunkfile")).toBe("python");
    expect(fileLanguageForPath("ReplacementHunkfile")).toBe("text");
    replaceExtensionFileLanguages([]);
  });

  test("resolves the persisted-comments path only when the option is on and a git dir exists", async () => {
    const repo = mkdtempSync(join(tmpdir(), "hunk-bootstrap-repo-"));
    const plain = mkdtempSync(join(tmpdir(), "hunk-bootstrap-plain-"));
    try {
      expect(Bun.spawnSync(["git", "init"], { cwd: repo, stderr: "ignore" }).exitCode).toBe(0);
      const load = async (repoCwd: string, persistComments: boolean) => {
        const input: CliInput = {
          kind: "vcs",
          staged: false,
          options: { vcs: "git", persistComments },
        };
        return loadConfiguredSessionBootstrap({
          configured: createTestConfig(input),
          cwd: repoCwd,
          loadAppBootstrapImpl: async (resolvedInput) => ({
            ...createTestBootstrap(resolvedInput),
            reloadContext: { cwd: repoCwd },
          }),
        });
      };

      const persisted = await load(repo, true);
      expect(persisted.bootstrap.persistedCommentsPath).toBe(
        join(realpathSync.native(repo), ".git", "hunk", "review-comments.json"),
      );
      expect(persisted.bootstrap.startupNotices ?? []).toEqual([]);

      const disabled = await load(repo, false);
      expect(disabled.bootstrap.persistedCommentsPath).toBeUndefined();

      const outsideRepo = await load(plain, true);
      expect(outsideRepo.bootstrap.persistedCommentsPath).toBeUndefined();
      expect(outsideRepo.bootstrap.startupNotices).toMatchObject([
        { key: "persist-comments:unavailable" },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

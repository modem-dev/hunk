import { describe, expect, test } from "bun:test";
import type { HunkConfigResolution } from "../core/config";
import type { AppBootstrap, CliInput } from "../core/types";
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

/** Create an externally resolved promise for reload-lifetime tests. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
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

  test("rejects a bootstrap whose reload signal was aborted while loading", async () => {
    const input = createTestInput();
    const load = deferred<AppBootstrap>();
    const controller = new AbortController();
    let loaderSignal: AbortSignal | undefined;
    const pending = loadConfiguredSessionBootstrap({
      configured: createTestConfig(input),
      cwd: process.cwd(),
      signal: controller.signal,
      loadAppBootstrapImpl: async (_resolvedInput, options) => {
        loaderSignal = options?.signal;
        return await load.promise;
      },
    });

    await Promise.resolve();
    expect(loaderSignal).toBe(controller.signal);
    controller.abort();
    load.resolve(createTestBootstrap(input));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

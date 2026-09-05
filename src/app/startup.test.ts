import { describe, expect, test } from "bun:test";
import { createEmptyExtensionLoadResult } from "../extensions/types";
import { resolveExtensionCliCommands } from "../extensions/cliCommands";
import type { HunkConfigResolution } from "../core/run/config";
import { HunkUserError } from "../core/run/errors";
import { prepareStartupPlan, shouldUseInteractiveHistory } from "./startup";
import type { AppBootstrap } from "../core/bootstrap";
import type { CliInput, ParsedCliInput } from "../core/run/commandInputs";
import type { NamedCustomThemeConfig } from "../extension-api/types";

/**
 * Build a config resolution for tests that are not exercising config layering.
 *
 * Extensions are disabled so startup planning never reaches the user's real
 * extensions directory during unit tests.
 */
function createTestConfigResolution(
  input: CliInput,
  overrides: Partial<HunkConfigResolution> = {},
): HunkConfigResolution {
  return {
    input,
    customThemes: [],
    extensions: { enabled: false, paths: [], repoPaths: [], extensionConfigs: {} },
    keybindings: {},
    ...overrides,
  };
}

function createBootstrap(input: CliInput): AppBootstrap {
  return {
    input,
    reloadContext: { cwd: process.cwd() },
    changeset: {
      id: "changeset:startup",
      sourceLabel: "repo",
      title: "repo working tree",
      files: [],
    },
    initialMode: input.options.mode ?? "auto",
  };
}

describe("history surface selection", () => {
  test("opens one automatic browser only when both standard streams are terminals", () => {
    expect(
      shouldUseInteractiveHistory({ forceStatic: false, stdinIsTTY: true, stdoutIsTTY: true }),
    ).toBe(true);
    expect(
      shouldUseInteractiveHistory({ forceStatic: false, stdinIsTTY: false, stdoutIsTTY: true }),
    ).toBe(false);
    expect(
      shouldUseInteractiveHistory({ forceStatic: false, stdinIsTTY: true, stdoutIsTTY: false }),
    ).toBe(false);
    expect(
      shouldUseInteractiveHistory({ forceStatic: true, stdinIsTTY: true, stdoutIsTTY: true }),
    ).toBe(false);
  });
});

describe("startup planning", () => {
  test("runs an extension CLI command and retires its registry before returning", async () => {
    const invocation = {
      kind: "extension-cli" as const,
      commandName: "tools",
      args: ["status"],
      extensionPaths: ["/tools.ts"],
      extensionsEnabled: true,
    };
    const extensions = createEmptyExtensionLoadResult();
    let shutdowns = 0;
    extensions.registry.extensions.push({ id: "tools", sourcePath: "/tools.ts", origin: "flag" });
    extensions.registry.cliCommands.push({
      extensionId: "tools",
      command: { name: "tools", summary: "Tools" },
      handler: (args) => {
        expect(args).toEqual(["status"]);
        return { kind: "exit", code: 6 };
      },
    });
    extensions.registry.eventHandlers.shutdown.push({
      extensionId: "tools",
      handler: () => {
        shutdowns += 1;
      },
    });

    const plan = await prepareStartupPlan(["bun", "hunk", "tools", "status"], {
      parseCliImpl: async () => invocation,
      resolveExtensionCliBootstrapImpl: async ({ baseVcsCatalog }) => ({
        configured: {
          extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
        },
        extensions,
        commands: resolveExtensionCliCommands(extensions.registry),
        collisionIssues: [],
        discoveryCatalog: baseVcsCatalog,
      }),
    });

    expect(plan).toEqual({ kind: "extension-cli-exit", exitCode: 6 });
    expect(shutdowns).toBe(1);
  });

  test("delegates once to a built-in headless plan and retires before returning", async () => {
    const invocation = {
      kind: "extension-cli" as const,
      commandName: "tools",
      args: [],
      extensionPaths: ["/tools.ts"],
      extensionsEnabled: true,
    };
    const extensions = createEmptyExtensionLoadResult();
    let shutdowns = 0;
    extensions.registry.extensions.push({ id: "tools", sourcePath: "/tools.ts", origin: "flag" });
    extensions.registry.cliCommands.push({
      extensionId: "tools",
      command: { name: "tools", summary: "Tools" },
      handler: () => ({ kind: "delegate", argv: ["--version"] }),
    });
    extensions.registry.eventHandlers.shutdown.push({
      extensionId: "tools",
      handler: () => {
        shutdowns += 1;
      },
    });

    const plan = await prepareStartupPlan(["bun", "hunk", "tools"], {
      parseCliImpl: async (argv) =>
        argv.includes("--version") ? { kind: "help", text: "1.2.3\n" } : invocation,
      resolveExtensionCliBootstrapImpl: async ({ baseVcsCatalog }) => ({
        configured: {
          extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
        },
        extensions,
        commands: resolveExtensionCliCommands(extensions.registry),
        collisionIssues: [],
        discoveryCatalog: baseVcsCatalog,
      }),
    });

    expect(plan).toEqual({ kind: "help", text: "1.2.3\n" });
    expect(shutdowns).toBe(1);
  });

  test("carries validated review metadata only into a delegated patch bootstrap", async () => {
    const invocation = {
      kind: "extension-cli" as const,
      commandName: "tools",
      args: [],
      extensionPaths: ["/tools.ts"],
      extensionsEnabled: true,
    };
    const patchInput: CliInput = { kind: "patch", file: "/tmp/review.diff", options: {} };
    const review = {
      kind: "change-request" as const,
      provider: "GitHub",
      title: "Add metadata",
      url: "https://github.com/modem-dev/hunk/pull/123",
      id: "#123",
      author: "octocat",
      base: "main",
      head: "metadata",
    };
    const extensions = createEmptyExtensionLoadResult();
    extensions.registry.extensions.push({ id: "tools", sourcePath: "/tools.ts", origin: "flag" });
    extensions.registry.cliCommands.push({
      extensionId: "tools",
      command: { name: "tools", summary: "Tools" },
      handler: () => ({ kind: "delegate", argv: ["patch", "/tmp/review.diff"], review }),
    });

    const plan = await prepareStartupPlan(["bun", "hunk", "tools"], {
      parseCliImpl: async (argv) => (argv.includes("patch") ? patchInput : invocation),
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) =>
        createTestConfigResolution(input, {
          extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
        }),
      resolveExtensionCliBootstrapImpl: async ({ baseVcsCatalog }) => ({
        configured: {
          extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
        },
        extensions,
        commands: resolveExtensionCliCommands(extensions.registry),
        collisionIssues: [],
        discoveryCatalog: baseVcsCatalog,
      }),
      loadStartupExtensionsImpl: async () => extensions,
      loadAppBootstrapImpl: async (input) => createBootstrap(input),
      usesPipedPatchInputImpl: () => false,
    });

    expect(plan.kind).toBe("app");
    if (plan.kind !== "app") throw new Error("Expected app plan.");
    expect(plan.bootstrap.review).toEqual(review);
    expect(Object.isFrozen(plan.bootstrap.review)).toBe(true);
  });

  test("rejects review metadata when delegation targets a non-patch built-in", async () => {
    const invocation = {
      kind: "extension-cli" as const,
      commandName: "tools",
      args: [],
      extensionPaths: ["/tools.ts"],
      extensionsEnabled: true,
    };
    const extensions = createEmptyExtensionLoadResult();
    extensions.registry.extensions.push({ id: "tools", sourcePath: "/tools.ts", origin: "flag" });
    extensions.registry.cliCommands.push({
      extensionId: "tools",
      command: { name: "tools", summary: "Tools" },
      handler: () => ({
        kind: "delegate",
        argv: ["--version"],
        review: { kind: "commit", provider: "GitHub", title: "Commit", revision: "abc" },
      }),
    });

    await expect(
      prepareStartupPlan(["bun", "hunk", "tools"], {
        parseCliImpl: async (argv) =>
          argv.includes("--version") ? { kind: "help", text: "1.2.3\n" } : invocation,
        resolveExtensionCliBootstrapImpl: async ({ baseVcsCatalog }) => ({
          configured: {
            extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
          },
          extensions,
          commands: resolveExtensionCliCommands(extensions.registry),
          collisionIssues: [],
          discoveryCatalog: baseVcsCatalog,
        }),
      }),
    ).rejects.toThrow("only to a delegated patch command");
  });

  test("lists the loaded extension commands when the requested token is unclaimed", async () => {
    const invocation = {
      kind: "extension-cli" as const,
      commandName: "toolz",
      args: [],
      extensionPaths: ["/tools.ts"],
      extensionsEnabled: true,
    };
    const extensions = createEmptyExtensionLoadResult();
    extensions.registry.extensions.push({ id: "tools", sourcePath: "/tools.ts", origin: "flag" });
    extensions.registry.cliCommands.push({
      extensionId: "tools",
      command: { name: "tools", summary: "Demonstrate workflows", usage: "<status|review>" },
      handler: () => ({ kind: "exit" }),
    });

    const plan = prepareStartupPlan(["bun", "hunk", "toolz"], {
      parseCliImpl: async () => invocation,
      resolveExtensionCliBootstrapImpl: async ({ baseVcsCatalog }) => ({
        configured: {
          extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
        },
        extensions,
        commands: resolveExtensionCliCommands(extensions.registry),
        collisionIssues: [],
        discoveryCatalog: baseVcsCatalog,
      }),
    });

    await expect(plan).rejects.toMatchObject({
      message: "Unknown command: toolz",
      suggestions: [
        "Extension commands available here:",
        "hunk tools <status|review> — Demonstrate workflows",
      ],
    });
  });

  test("rejects a disabled extension command before bootstrap resolution", async () => {
    let resolved = false;

    await expect(
      prepareStartupPlan(["bun", "hunk", "--no-extensions", "tools"], {
        parseCliImpl: async () => ({
          kind: "extension-cli",
          commandName: "tools",
          args: [],
          extensionPaths: [],
          extensionsEnabled: false,
        }),
        resolveExtensionCliBootstrapImpl: async () => {
          resolved = true;
          throw new Error("must not resolve");
        },
      }),
    ).rejects.toThrow("Unknown command: tools");
    expect(resolved).toBe(false);
  });

  test("returns help output without entering app startup", async () => {
    let loaded = false;

    const plan = await prepareStartupPlan(["bun", "hunk"], {
      parseCliImpl: async () => ({ kind: "help", text: "Usage: hunk\n" }),
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({ kind: "help", text: "Usage: hunk\n" });
    expect(loaded).toBe(false);
  });

  test("passes the daemon serve command through without app bootstrap work", async () => {
    let loaded = false;

    const plan = await prepareStartupPlan(["bun", "hunk", "daemon", "serve"], {
      parseCliImpl: async () => ({ kind: "daemon-serve" }),
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({ kind: "daemon-serve" });
    expect(loaded).toBe(false);
  });

  test("passes session commands through without app bootstrap work", async () => {
    let loaded = false;

    const plan = await prepareStartupPlan(["bun", "hunk", "session", "list"], {
      parseCliImpl: async () => ({
        kind: "session",
        action: "list",
        output: "text",
      }),
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({
      kind: "session-command",
      input: { kind: "session", action: "list", output: "text" },
    });
    expect(loaded).toBe(false);
  });

  test("routes non-diff pager stdin to the plain-text pager path", async () => {
    let loaded = false;

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({
        kind: "pager",
        options: { theme: "github-light-default" },
      }),
      readStdinText: async () => "* main\n  feature/demo\n",
      looksLikePatchInputImpl: () => false,
      stdoutIsTTY: true,
      env: { TERM: "xterm-256color" },
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({
      kind: "plain-text-pager",
      text: "* main\n  feature/demo\n",
    });
    expect(loaded).toBe(false);
  });

  test("passes non-diff pager stdin through for captured pager hosts", async () => {
    let loaded = false;
    const text = "* main\n  feature/demo\n";

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({
        kind: "pager",
        options: { theme: "github-light-default" },
      }),
      readStdinText: async () => text,
      looksLikePatchInputImpl: () => false,
      stdoutIsTTY: true,
      env: { TERM: "dumb", LAZYGIT_NEW_DIR_FILE: "/tmp/lazygit-dir" },
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    // Captured hosts draw this text themselves, so Git's colors have to survive.
    expect(plan).toEqual({ kind: "passthrough", text, preserveColor: true });
    expect(loaded).toBe(false);
  });

  test("passes non-diff pager stdin through for a plain dumb terminal", async () => {
    let loaded = false;
    const text = "* main\n  feature/demo\n";

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({ kind: "pager", options: {} }),
      readStdinText: async () => text,
      looksLikePatchInputImpl: () => false,
      stdoutIsTTY: true,
      env: { TERM: "dumb" },
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    // A genuinely dumb terminal would print the escape sequences as literal text.
    expect(plan).toEqual({ kind: "passthrough", text, preserveColor: false });
    expect(loaded).toBe(false);
  });

  test("normalizes diff-like pager stdin into patch app startup", async () => {
    const seenInputs: CliInput[] = [];

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({
        kind: "pager",
        options: { theme: "github-light-default" },
      }),
      readStdinText: async () => "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      looksLikePatchInputImpl: () => true,
      stdoutIsTTY: true,
      env: { TERM: "xterm-256color" },
      openControllingTerminalImpl: () => ({
        stdin: {} as never,
        close: () => {},
      }),
      resolveRuntimeCliInputImpl(input) {
        seenInputs.push(input);
        return input;
      },
      resolveConfiguredCliInputImpl(input) {
        seenInputs.push(input);
        return createTestConfigResolution(input);
      },
      loadAppBootstrapImpl: async (input) => {
        seenInputs.push(input);
        return createBootstrap(input);
      },
      usesPipedPatchInputImpl: () => false,
    });

    expect(plan.kind).toBe("app");
    if (plan.kind !== "app") {
      throw new Error("Expected app startup plan.");
    }

    expect(plan.cliInput).toMatchObject({
      kind: "patch",
      file: "-",
      text: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      options: {
        theme: "github-light-default",
        pager: true,
      },
    });
    expect(seenInputs).toHaveLength(3);
  });

  test("passes diff-like pager stdin through when stdout is not interactive", async () => {
    let loaded = false;
    const patchText = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({ kind: "pager", options: {} }),
      readStdinText: async () => patchText,
      looksLikePatchInputImpl: () => true,
      stdoutIsTTY: false,
      env: { TERM: "xterm-256color" },
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({ kind: "passthrough", text: patchText, preserveColor: false });
    expect(loaded).toBe(false);
  });

  test("passes diff-like pager stdin through for a plain dumb terminal", async () => {
    let loaded = false;
    const patchText = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({ kind: "pager", options: {} }),
      readStdinText: async () => patchText,
      looksLikePatchInputImpl: () => true,
      stdoutIsTTY: true,
      env: { TERM: "dumb" },
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({ kind: "passthrough", text: patchText, preserveColor: false });
    expect(loaded).toBe(false);
  });

  test("routes diff-like pager stdin to static output when the host advertises a captured pager", async () => {
    let loaded = false;
    const patchText = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const customThemes = [{ id: "custom", base: "github-light-default", text: "#123456" }];

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({
        kind: "pager",
        options: { theme: "custom" },
      }),
      readStdinText: async () => patchText,
      looksLikePatchInputImpl: () => true,
      stdoutIsTTY: true,
      env: { TERM: "dumb", LV: "-c" },
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) =>
        createTestConfigResolution(
          {
            ...input,
            options: { ...input.options, lineNumbers: false, theme: "custom" },
          },
          { customThemes },
        ),
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({
      kind: "static-diff-pager",
      text: patchText,
      options: { theme: "custom", pager: true, lineNumbers: false },
      customThemes,
    });
    expect(loaded).toBe(false);
  });

  test("routes diff-like pager stdin to static output when no controlling terminal is available", async () => {
    let loaded = false;
    const patchText = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

    const plan = await prepareStartupPlan(["bun", "hunk", "pager"], {
      parseCliImpl: async () => ({ kind: "pager", options: {} }),
      readStdinText: async () => patchText,
      looksLikePatchInputImpl: () => true,
      stdoutIsTTY: true,
      env: { TERM: "xterm-256color" },
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) => createTestConfigResolution(input),
      openControllingTerminalImpl: () => null,
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({
      kind: "static-diff-pager",
      text: patchText,
      options: { pager: true },
    });
    expect(loaded).toBe(false);
  });

  test("passes configured custom theme data into app bootstrap", async () => {
    const cliInput: CliInput = {
      kind: "patch",
      file: "-",
      options: {
        theme: "custom",
      },
    };
    const customThemes = [
      {
        id: "custom",
        base: "github-dark-default",
        accent: "#123456",
      },
    ];

    await prepareStartupPlan(["bun", "hunk", "patch", "-"], {
      parseCliImpl: async () => cliInput as ParsedCliInput,
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) => createTestConfigResolution(input, { customThemes }),
      loadAppBootstrapImpl: async (input, options) => {
        expect(input).toBe(cliInput);
        expect(options).toMatchObject({ customThemes });
        expect(options?.vcsCatalog?.defaultAdapterId).toBe("git");
        return {
          ...createBootstrap(input),
          customThemes,
        };
      },
      usesPipedPatchInputImpl: () => false,
    });
  });

  test("carries configured startup notices into the app bootstrap", async () => {
    const cliInput: CliInput = {
      kind: "patch",
      file: "-",
      options: {},
    };
    const startupNotice = {
      key: "deprecated:custom-theme-syntax",
      message: "Legacy custom theme syntax detected",
    };

    const plan = await prepareStartupPlan(["bun", "hunk", "patch", "-"], {
      parseCliImpl: async () => cliInput as ParsedCliInput,
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) =>
        createTestConfigResolution(input, { startupNotices: [startupNotice] }),
      loadAppBootstrapImpl: async (input) => createBootstrap(input),
      usesPipedPatchInputImpl: () => false,
    });

    expect(plan.kind).toBe("app");
    if (plan.kind === "app") {
      expect(plan.bootstrap.startupNotices).toEqual([startupNotice]);
    }
  });

  test("rejects watch mode before affected Bun runtimes can deadlock", async () => {
    const cliInput: CliInput = {
      kind: "vcs",
      staged: false,
      options: { watch: true },
    };
    let loaded = false;
    let opened = false;

    await expect(
      prepareStartupPlan(["bun", "hunk", "diff", "--watch"], {
        bunVersion: "1.3.10",
        parseCliImpl: async () => cliInput as ParsedCliInput,
        resolveRuntimeCliInputImpl: (input) => input,
        resolveConfiguredCliInputImpl: (input) => createTestConfigResolution(input),
        loadAppBootstrapImpl: async (input) => {
          loaded = true;
          return createBootstrap(input);
        },
        openControllingTerminalImpl: () => {
          opened = true;
          return { stdin: {} as never, close: () => {} };
        },
        stdinIsTTY: false,
        stdoutIsTTY: true,
      }),
    ).rejects.toThrow("can deadlock while closing filesystem watchers");
    expect(loaded).toBe(false);
    expect(opened).toBe(false);
  });

  test("rejects watch mode for stdin-backed patch inputs", async () => {
    const cliInput: CliInput = {
      kind: "patch",
      file: "-",
      options: {
        watch: true,
      },
    };

    await expect(
      prepareStartupPlan(["bun", "hunk", "patch", "-", "--watch"], {
        parseCliImpl: async () => cliInput as ParsedCliInput,
        resolveRuntimeCliInputImpl: (input) => input,
        resolveConfiguredCliInputImpl: (input) => createTestConfigResolution(input),
      }),
    ).rejects.toBeInstanceOf(HunkUserError);
  });

  test("opens the controlling terminal for any app startup with piped stdin", async () => {
    const cliInput: CliInput = {
      kind: "vcs",
      staged: false,
      options: {
        theme: "github-dark-default",
      },
    };
    const controllingTerminal = { stdin: {} as never, close: () => {} };
    let opened = 0;

    const plan = await prepareStartupPlan(
      ["bun", "hunk", "diff", "--theme", "github-dark-default"],
      {
        parseCliImpl: async () => cliInput as ParsedCliInput,
        resolveRuntimeCliInputImpl: (input) => input,
        resolveConfiguredCliInputImpl: (input) => createTestConfigResolution(input),
        loadAppBootstrapImpl: async (input) => createBootstrap(input),
        openControllingTerminalImpl: () => {
          opened += 1;
          return controllingTerminal;
        },
        stdinIsTTY: false,
        stdoutIsTTY: true,
      },
    );

    expect(plan).toMatchObject({
      kind: "app",
      cliInput,
      controllingTerminal,
    });
    expect(opened).toBe(1);
  });

  test("detects auto theme through the controlling terminal before app startup", async () => {
    const cliInput: CliInput = {
      kind: "patch",
      file: "-",
      options: {
        theme: "auto",
        pager: true,
      },
    };
    const controllingTerminal = { stdin: {} as never, close: () => {} };
    let opened = 0;

    const plan = await prepareStartupPlan(["bun", "hunk", "patch", "-", "--theme", "auto"], {
      parseCliImpl: async () => cliInput as ParsedCliInput,
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) => createTestConfigResolution(input),
      loadAppBootstrapImpl: async (input) => createBootstrap(input),
      openControllingTerminalImpl: () => {
        opened += 1;
        return controllingTerminal;
      },
      detectTerminalThemeModeFromBackgroundImpl: async ({ input }) => {
        expect(input).toBe(controllingTerminal.stdin);
        return "dark";
      },
      stdinIsTTY: false,
      stdoutIsTTY: true,
      stdout: { write: () => true } as never,
    });

    expect(plan).toMatchObject({
      kind: "app",
      controllingTerminal,
      bootstrap: { initialThemeMode: "dark" },
    });
    expect(opened).toBe(1);
  });

  test("inherits handoff theme mode without querying the parent-owned terminal", async () => {
    const cliInput: CliInput = {
      kind: "show",
      ref: "opaque:id",
      options: { theme: "auto" },
    };
    let detected = 0;

    const plan = await prepareStartupPlan(["bun", "hunk", "show", "opaque:id"], {
      parseCliImpl: async () => cliInput as ParsedCliInput,
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) => createTestConfigResolution(input),
      loadAppBootstrapImpl: async (input) => createBootstrap(input),
      detectTerminalThemeModeFromBackgroundImpl: async () => {
        detected += 1;
        return "light";
      },
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: {
        HUNK_TERMINAL_HANDOFF: "1",
        HUNK_TERMINAL_HANDOFF_THEME_MODE: "dark",
      },
    });

    expect(plan).toMatchObject({ kind: "app", bootstrap: { initialThemeMode: "dark" } });
    expect(detected).toBe(0);
  });

  test("opens the controlling terminal for piped patch startup", async () => {
    const cliInput: CliInput = {
      kind: "patch",
      file: "-",
      options: {
        mode: "auto",
        pager: true,
      },
    };
    const controllingTerminal = {
      stdin: {} as never,
      stdout: {} as never,
      close: () => {},
    };
    let opened = 0;

    const plan = await prepareStartupPlan(["bun", "hunk", "patch", "-"], {
      parseCliImpl: async () => cliInput as ParsedCliInput,
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) => createTestConfigResolution(input),
      loadAppBootstrapImpl: async (input) => createBootstrap(input),
      usesPipedPatchInputImpl: (input) => {
        expect(input).toBe(cliInput);
        return true;
      },
      openControllingTerminalImpl: () => {
        opened += 1;
        return controllingTerminal;
      },
    });

    expect(plan).toMatchObject({
      kind: "app",
      cliInput,
      controllingTerminal,
    });
    expect(opened).toBe(1);
  });

  test("loads extensions before the changeset and attaches them to the bootstrap", async () => {
    const cliInput: CliInput = {
      kind: "patch",
      file: "-",
      options: { extensionPaths: ["./dev-extension.ts"] },
    };
    const extensionResult = {
      ...createEmptyExtensionLoadResult(),
      issues: [
        {
          extensionId: "broken",
          path: "/tmp/broken.ts",
          origin: "flag" as const,
          message: "boom",
        },
      ],
    };
    const order: string[] = [];

    const plan = await prepareStartupPlan(["bun", "hunk", "patch", "-"], {
      parseCliImpl: async () => cliInput as ParsedCliInput,
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) =>
        createTestConfigResolution(input, {
          extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
        }),
      loadStartupExtensionsImpl: async (options) => {
        order.push("extensions");
        expect(options.cliExtensionPaths).toEqual(["./dev-extension.ts"]);
        expect(options.extensions.enabled).toBe(true);
        return extensionResult;
      },
      loadAppBootstrapImpl: async (input) => {
        order.push("bootstrap");
        return createBootstrap(input);
      },
      usesPipedPatchInputImpl: () => false,
    });

    expect(order).toEqual(["extensions", "bootstrap"]);
    expect(plan.kind).toBe("app");
    if (plan.kind !== "app") {
      throw new Error("Expected app startup plan.");
    }

    expect(plan.bootstrap.extensions).toBe(extensionResult);
    // Load failures reach the user through the existing startup notice channel.
    expect(plan.bootstrap.startupNotices).toEqual([
      { key: "extension:/tmp/broken.ts", message: "Extension broken failed to load • boom" },
    ]);
  });

  test("merges extension themes behind config themes and reports the collisions", async () => {
    const cliInput: CliInput = { kind: "patch", file: "-", options: { theme: "ocean" } };
    const extensionResult = createEmptyExtensionLoadResult();
    extensionResult.registry.themes.push(
      { extensionId: "pack", theme: { id: "ocean", accent: "#654321" } },
      { extensionId: "pack", theme: { id: "sunset", accent: "#abcdef" } },
      { extensionId: "pack", theme: { id: "Bad Id" } },
    );
    let bootstrapOptions: { customThemes?: readonly NamedCustomThemeConfig[] } | undefined;

    const plan = await prepareStartupPlan(["bun", "hunk", "patch", "-"], {
      parseCliImpl: async () => cliInput as ParsedCliInput,
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) =>
        createTestConfigResolution(input, {
          customThemes: [{ id: "ocean", accent: "#123456" }],
          extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
        }),
      loadStartupExtensionsImpl: async () => extensionResult,
      loadAppBootstrapImpl: async (input, options) => {
        bootstrapOptions = options;
        return createBootstrap(input);
      },
      usesPipedPatchInputImpl: () => false,
    });

    // Config themes keep their id; extension themes fill the ids that are still free.
    expect(bootstrapOptions?.customThemes).toEqual([
      { id: "ocean", accent: "#123456" },
      { id: "sunset", accent: "#abcdef" },
    ]);
    expect(plan.kind).toBe("app");
    if (plan.kind !== "app") {
      throw new Error("Expected app startup plan.");
    }

    expect(plan.bootstrap.startupNotices?.map((notice) => notice.message)).toEqual([
      'Skipped theme "ocean" from extension pack • config already defines it',
      'Skipped theme "Bad Id" from extension pack • theme ids must be lowercase words separated by - or _',
    ]);
  });

  test("skips extension loading entirely when config disables it", async () => {
    const cliInput: CliInput = { kind: "patch", file: "-", options: { extensions: false } };
    let requestedExtensions: boolean | undefined;

    await prepareStartupPlan(["bun", "hunk", "patch", "-", "--no-extensions"], {
      parseCliImpl: async () => cliInput as ParsedCliInput,
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) => createTestConfigResolution(input),
      loadStartupExtensionsImpl: async (options) => {
        requestedExtensions = options.extensions.enabled;
        return createEmptyExtensionLoadResult();
      },
      loadAppBootstrapImpl: async (input) => createBootstrap(input),
      usesPipedPatchInputImpl: () => false,
    });

    expect(requestedExtensions).toBe(false);
  });
});

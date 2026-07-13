import { describe, expect, test } from "bun:test";
import { HunkUserError } from "./errors";
import { prepareStartupPlan } from "./startup";
import type { AppBootstrap, CliInput, ParsedCliInput } from "./types";

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

describe("startup planning", () => {
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

    expect(plan).toEqual({ kind: "passthrough", text });
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

    expect(plan).toEqual({ kind: "passthrough", text });
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
        return { input } as never;
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
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({ kind: "passthrough", text: patchText });
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

    expect(plan).toEqual({ kind: "passthrough", text: patchText });
    expect(loaded).toBe(false);
  });

  test("routes diff-like pager stdin to static output when the host advertises a captured pager", async () => {
    let loaded = false;
    const patchText = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const customTheme = { base: "github-light-default", text: "#123456" };

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
        ({
          input: {
            ...input,
            options: { ...input.options, lineNumbers: false, theme: "custom" },
          },
          customTheme,
        }) as never,
      loadAppBootstrapImpl: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });

    expect(plan).toEqual({
      kind: "static-diff-pager",
      text: patchText,
      options: { theme: "custom", pager: true, lineNumbers: false },
      customTheme,
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
      resolveConfiguredCliInputImpl: (input) => ({ input }) as never,
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
    const customTheme = {
      base: "github-dark-default",
      accent: "#123456",
    };

    await prepareStartupPlan(["bun", "hunk", "patch", "-"], {
      parseCliImpl: async () => cliInput as ParsedCliInput,
      resolveRuntimeCliInputImpl: (input) => input,
      resolveConfiguredCliInputImpl: (input) => ({ input, customTheme }) as never,
      loadAppBootstrapImpl: async (input, options) => {
        expect(input).toBe(cliInput);
        expect(options).toEqual({ customTheme });
        return {
          ...createBootstrap(input),
          customTheme,
        };
      },
      usesPipedPatchInputImpl: () => false,
    });
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
        resolveConfiguredCliInputImpl: (input) => ({ input }) as never,
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
        resolveConfiguredCliInputImpl: (input) => ({ input }) as never,
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
      resolveConfiguredCliInputImpl: (input) => ({ input }) as never,
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
      resolveConfiguredCliInputImpl: (input) => ({ input }) as never,
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
});
